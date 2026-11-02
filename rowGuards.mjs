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
 *   - a dated row that is much sparser than its siblings and whose amount
 *     equals the sum of the other rows is also an aggregate, even though the
 *     date alone made it look identified;
 *   - the caller opts in per template.
 */

const DESCRIPTION_LIKE = /^(description|desc|details?|particulars?|remarks?|notes?|narration|narrative|charges?_?type|type|item|item_?name|subject|currency)$/i;
const AMOUNT_LIKE = /(amount|total|net|gross|subtotal|value|charge|fee|tax|price)/i;

function hasValue(value) {
  return value !== null && value !== undefined && String(value).trim() !== '';
}

function numericValue(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value.replace(/[,\s]/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function numericFieldNames(field) {
  return itemFieldDefs(field)
    .filter((def) => def && (def.type === 'number' || def.type === 'integer'))
    .map((def) => def.name);
}

/**
 * Drop aggregate rows that a model copied out of a totals block but that carry
 * a date (so the identity rule above keeps them).
 *
 * A row is an aggregate when it is structurally much sparser than its siblings
 * AND one of its amount fields equals the sum of that same field on every other
 * row. Example: a page-1 invoice line "LANDING CHARGE INTERNATIONAL, quantity
 * 23, amount 3,630,550" next to the 23 annexure rows of 157,850 each. The row
 * has a date, but no flight/registration/times, and its amount is the sum.
 *
 * Requiring both signals keeps a legitimate dense row that happens to share an
 * amount with the sum from being removed, and leaves small arrays alone.
 */
function dropAggregateRows(rows, field, identity) {
  if (rows.length < 4) return rows;
  const numeric = numericFieldNames(field).filter((name) => AMOUNT_LIKE.test(name));
  if (numeric.length === 0 || identity.length < 2) return rows;

  const strongIdentity = identity.filter((name) => {
    const nonEmpty = rows.reduce((sum, row) => sum + (hasValue(row?.[name]) ? 1 : 0), 0);
    return nonEmpty / rows.length >= 0.8;
  });
  if (strongIdentity.length < 2) return rows;

  const kept = [];
  for (const row of rows) {
    const others = rows.filter((other) => other !== row);
    const missing = strongIdentity.filter((name) => !hasValue(row?.[name])).length;
    const sparse = missing >= Math.ceil(strongIdentity.length / 2);
    if (!sparse) { kept.push(row); continue; }

    const isAggregate = numeric.some((name) => {
      const value = numericValue(row?.[name]);
      if (value == null) return false;
      const values = others.map((other) => numericValue(other?.[name]));
      if (values.length < 3 || values.some((v) => v == null)) return false;
      const sum = values.reduce((a, b) => a + b, 0);
      const tolerance = Math.max(0.01, Math.abs(sum) * 1e-6);
      return value >= Math.max(...values) && Math.abs(value - sum) <= tolerance;
    });

    if (isAggregate) continue;
    kept.push(row);
  }
  return kept;
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

  const identifiedRows = rows.filter(isIdentified);
  const kept = dropAggregateRows(identifiedRows, field, discriminating);
  if (kept.length === 0) return unchanged('all-rows-look-aggregate');
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
