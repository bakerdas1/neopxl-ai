/**
 * Row guards applied to extracted arrays after the model has responded.
 *
 * Problem this solves: invoices often print a summary block ("LandingCharges",
 * "Night-LandingCharges", ...) that looks structurally identical to a line
 * item. Models routinely copy those aggregate lines into the detail array,
 * inflating row counts (e.g. 35 real flights -> 38 rows). Prompt instructions
 * alone do not stop it.
 *
 * The rule is deliberately narrow and schema-driven:
 *   - a row is "identified" when at least one identity field holds a value;
 *   - identity fields are the string fields of the array item, excluding
 *     label/value fields such as description, charges_type, currency;
 *   - rows with no identity value are dropped only when at least
 *     `minIdentifiedRatio` of their siblings are identified, so a genuinely
 *     unusual document (mostly non-flight fee rows) is left untouched;
 *   - the caller opts in per template.
 */

const DESCRIPTION_LIKE = /^(description|desc|details?|particulars?|remarks?|notes?|narration|narrative|charges?_?type|type|item|item_?name|subject|currency)$/i;

function hasValue(value) {
  return value !== null && value !== undefined && String(value).trim() !== '';
}

function itemFieldDefs(field) {
  const props = field?.items?.properties;
  if (props && typeof props === 'object') {
    return Object.entries(props).map(([name, def]) => ({ name, ...def }));
  }
  // `children` is the internal converted shape (see jsonSchemaToDocumind).
  if (Array.isArray(field?.children)) return field.children;
  return [];
}

export function identityFieldNames(field) {
  const defs = itemFieldDefs(field);
  if (defs.length === 0) return [];
  return defs
    .filter((def) => def && def.type === 'string' && !DESCRIPTION_LIKE.test(def.name || ''))
    .map((def) => def.name);
}

/**
 * @param {Array<object>} rows
 * @param {object} field  documind array field definition ({ name, type: 'array', items })
 * @param {{ minIdentifiedRatio?: number }} [options]
 * @returns {{ rows: Array<object>, dropped: number, reason?: string }}
 */
export function dropUnidentifiedSummaryRows(rows, field, options = {}) {
  const minIdentifiedRatio = Number.isFinite(options.minIdentifiedRatio) ? options.minIdentifiedRatio : 0.8;
  const unchanged = (reason) => ({ rows, dropped: 0, reason });

  if (!Array.isArray(rows) || rows.length === 0) return unchanged('empty');
  if (field?.type !== 'array') return unchanged('not-an-array');

  const identity = identityFieldNames(field);
  if (identity.length === 0) return unchanged('no-identity-fields');

  // A field that holds the same value on every row (airport, currency, a fixed
  // operator name) says nothing about whether a row is a real line item, so it
  // must not count as an identifier. Only fields that actually vary qualify.
  const discriminating = identity.filter((name) => {
    const values = new Set();
    let nonEmpty = 0;
    for (const row of rows) {
      if (hasValue(row?.[name])) { values.add(String(row[name]).trim()); nonEmpty += 1; }
    }
    if (values.size <= 1) return false;
    // Context fields (airport, operator, a single aircraft) are filled on
    // almost every row and take only a value or two: they do not identify a
    // line item, so they must not make a summary row look real.
    const looksLikeContext = rows.length >= 10 && nonEmpty / rows.length >= 0.95 && values.size <= 2;
    return !looksLikeContext;
  });
  if (discriminating.length === 0) return unchanged('no-varying-identity-fields');

  const isIdentified = (row) => discriminating.some((name) => hasValue(row?.[name]));
  const identifiedCount = rows.reduce((sum, row) => sum + (isIdentified(row) ? 1 : 0), 0);

  if (identifiedCount / rows.length < minIdentifiedRatio) {
    return unchanged('below-identified-ratio');
  }

  const kept = rows.filter(isIdentified);
  const dropped = rows.length - kept.length;
  if (dropped === 0) return unchanged('none-unidentified');

  return { rows: kept, dropped };
}

/**
 * Apply the guard to every array field in a schema.
 * @returns {{ data: object, dropped: number, byField: Record<string, number> }}
 */
export function dropSummaryRowsFromResult(data, schema, options = {}) {
  if (!data || typeof data !== 'object' || !Array.isArray(schema)) {
    return { data, dropped: 0, byField: {} };
  }
  let total = 0;
  const byField = {};
  let out = data;
  for (const field of schema) {
    if (field?.type !== 'array') continue;
    const rows = out[field.name];
    if (!Array.isArray(rows)) continue;
    const res = dropUnidentifiedSummaryRows(rows, field, options);
    if (res.dropped > 0) {
      if (out === data) out = { ...data };
      out[field.name] = res.rows;
      byField[field.name] = res.dropped;
      total += res.dropped;
    }
  }
  return { data: out, dropped: total, byField };
}
