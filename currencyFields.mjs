/**
 * Currency-aware schema normalization.
 *
 * Problem this solves: a schema can bake a currency into the *field name*
 * (`line_total_aed`, `line_total_usd`, `net_amount_inr`, ...). The document's
 * own currency is a single value (`currency`), and no FX conversion is done by
 * this app. When a document is in INR, or simply when several currency variants
 * exist, the model has no neutral place to put the amount and will park it in
 * whichever suffixed field looks closest to "total" — producing values labelled
 * with the wrong currency (e.g. an INR 467250 line total stored as
 * `line_total_aed`).
 *
 * The rule implemented here is generic and schema-driven, and deliberately
 * narrow:
 *   - only groups of TWO OR MORE numeric sibling fields whose names differ only
 *     by a trailing ISO-4217 currency code (same base name) are considered —
 *     that is where the model has no non-arbitrary choice;
 *   - such a group gets a currency-neutral sibling (the base name) when the
 *     schema does not already have one, so every amount has a correct home;
 *   - the model is told, via the field descriptions, that the suffixed variants
 *     are only for amounts explicitly denominated in that currency;
 *   - after extraction, a single populated variant is moved into the neutral
 *     field (preferring the variant that matches the document's `currency`), so
 *     the stored data carries the document currency rather than an arbitrary
 *     suffix.
 *
 * A schema with zero or one currency-suffixed numeric field is left completely
 * untouched: the suffix is unambiguous there, and other templates must not
 * change behaviour.
 */

const ISO_CURRENCY_CODES = new Set([
  'AED', 'AFN', 'ALL', 'AMD', 'ANG', 'AOA', 'ARS', 'AUD', 'AWG', 'AZN',
  'BAM', 'BBD', 'BDT', 'BGN', 'BHD', 'BIF', 'BMD', 'BND', 'BOB', 'BRL',
  'BSD', 'BTN', 'BWP', 'BYN', 'BZD', 'CAD', 'CDF', 'CHF', 'CLP', 'CNY',
  'COP', 'CRC', 'CUP', 'CVE', 'CZK', 'DJF', 'DKK', 'DOP', 'DZD', 'EGP',
  'ERN', 'ETB', 'EUR', 'FJD', 'FKP', 'GBP', 'GEL', 'GHS', 'GIP', 'GMD',
  'GNF', 'GTQ', 'GYD', 'HKD', 'HNL', 'HRK', 'HTG', 'HUF', 'IDR', 'ILS',
  'INR', 'IQD', 'IRR', 'ISK', 'JMD', 'JOD', 'JPY', 'KES', 'KGS', 'KHR',
  'KMF', 'KPW', 'KRW', 'KWD', 'KYD', 'KZT', 'LAK', 'LBP', 'LKR', 'LRD',
  'LSL', 'LYD', 'MAD', 'MDL', 'MGA', 'MKD', 'MMK', 'MNT', 'MOP', 'MRU',
  'MUR', 'MVR', 'MWK', 'MXN', 'MYR', 'MZN', 'NAD', 'NGN', 'NIO', 'NOK',
  'NPR', 'NZD', 'OMR', 'PAB', 'PEN', 'PGK', 'PHP', 'PKR', 'PLN', 'PYG',
  'QAR', 'RON', 'RSD', 'RUB', 'RWF', 'SAR', 'SBD', 'SCR', 'SDG', 'SEK',
  'SGD', 'SHP', 'SLE', 'SOS', 'SRD', 'SSP', 'STN', 'SVC', 'SYP', 'SZL',
  'THB', 'TJS', 'TMT', 'TND', 'TOP', 'TRY', 'TTD', 'TWD', 'TZS', 'UAH',
  'UGX', 'USD', 'UYU', 'UZS', 'VES', 'VND', 'VUV', 'WST', 'XAF', 'XCD',
  'XOF', 'XPF', 'YER', 'ZAR', 'ZMW', 'ZWL',
]);

const CURRENCY_ALIASES = {
  // Codes written as words
  USDOLLAR: 'USD', DOLLAR: 'USD', DOLLARS: 'USD', AMERICANDOLLAR: 'USD',
  EURO: 'EUR', EUROS: 'EUR', EUROPEANEURO: 'EUR',
  POUND: 'GBP', POUNDS: 'GBP', STERLING: 'GBP', BRITISHPOUND: 'GBP',
  RUPEE: 'INR', RUPEES: 'INR', RS: 'INR', INDIANRUPEE: 'INR', INDIANRUPEES: 'INR',
  DIRHAM: 'AED', DIRHAMS: 'AED', DH: 'AED', DHS: 'AED', UAEDIRHAM: 'AED', EMIRATIDIRHAM: 'AED',
  RIYAL: 'SAR', RIYALS: 'SAR', SAUDIRIYAL: 'SAR', SAUDIRIYALS: 'SAR',
  QATARIRIYAL: 'QAR', QATARIRIYALS: 'QAR',
  KUWAITIDINAR: 'KWD', BAHRAINIDINAR: 'BHD', OMANIRIAL: 'OMR',
  JORDANIANDINAR: 'JOD',
  EGYPTIANPOUND: 'EGP', TAKA: 'BDT', PAKISTANIRUPEE: 'PKR',
  SRILANKANRUPEE: 'LKR', NEPALESERUPEE: 'NPR',
  YEN: 'JPY', JAPANESEYEN: 'JPY', YUAN: 'CNY', RENMINBI: 'CNY',
  FRANC: 'CHF', SWISSFRANC: 'CHF', RAND: 'ZAR', LIRA: 'TRY',
};

const CURRENCY_SYMBOLS = {
  '$': 'USD', '€': 'EUR', '£': 'GBP', '₹': 'INR', '¥': 'JPY',
  '₽': 'RUB', '₩': 'KRW', '₺': 'TRY', '₦': 'NGN', '₱': 'PHP',
  '฿': 'THB', '₪': 'ILS', 'د.إ': 'AED', 'ر.س': 'SAR', '﷼': 'SAR',
};

const CURRENCY_SUFFIX_RE = /^(.+?)[_-]([A-Za-z]{3})$/;
const AUTO_NOTE_RE = /\s*Only populate when the document explicitly denominates this amount in [A-Z]{3}\.?$/;

export function isIsoCurrency(code) {
  return ISO_CURRENCY_CODES.has(String(code || '').toUpperCase());
}

/** Normalize a document currency value (code, name or symbol) to an ISO code. */
export function documentCurrencyCode(value) {
  if (value == null) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const upper = raw.toUpperCase();
  if (/^[A-Z]{3}$/.test(upper) && ISO_CURRENCY_CODES.has(upper)) return upper;
  const letters = upper.replace(/[^A-Z]/g, '');
  if (CURRENCY_ALIASES[letters]) return CURRENCY_ALIASES[letters];
  if (CURRENCY_SYMBOLS[raw]) return CURRENCY_SYMBOLS[raw];
  // "INR 1,234" / "USD 12" / "AED." — pick the first ISO code token.
  const token = upper.match(/\b[A-Z]{3}\b/);
  if (token && ISO_CURRENCY_CODES.has(token[0])) return token[0];
  return null;
}

function isAmountDef(def) {
  return def && typeof def === 'object' && (def.type === 'number' || def.type === 'integer');
}

/** Currency suffix of a numeric field name, or null when there is none. */
export function currencySuffix(name) {
  if (typeof name !== 'string') return null;
  const m = name.match(CURRENCY_SUFFIX_RE);
  if (!m) return null;
  const code = m[2].toUpperCase();
  return ISO_CURRENCY_CODES.has(code) ? { base: m[1], currency: code } : null;
}

/**
 * Add a neutral sibling for every group of currency-suffixed numeric fields.
 * Mutates and returns the schema array. Idempotent.
 */
export function normalizeCurrencyFields(schema) {
  normalizeContainer(Array.isArray(schema) ? schema : [], []);
  return schema;
}

function normalizeContainer(fields, path) {
  if (!Array.isArray(fields) || fields.length === 0) return;
  const byName = new Map();
  for (const f of fields) {
    if (f && typeof f === 'object' && typeof f.name === 'string') byName.set(f.name, f);
  }

  const groups = new Map();
  for (const f of fields) {
    if (!isAmountDef(f)) continue;
    const suffix = currencySuffix(f.name);
    if (!suffix) continue;
    if (!groups.has(suffix.base)) groups.set(suffix.base, []);
    groups.get(suffix.base).push({ def: f, ...suffix });
  }

  for (const [base, members] of groups) {
    // A lone currency-suffixed field is unambiguous. Only a set of variants
    // forces the model to guess, so only those are normalized.
    if (members.length < 2) continue;
    if (!byName.has(base)) {
      const neutral = {
        name: base,
        type: 'number',
        description: `The ${base.replace(/[_-]+/g, ' ')} amount in the document's currency (see currency).`,
      };
      fields.push(neutral);
      byName.set(base, neutral);
    }
    for (const { def, currency } of members) {
      const original = String(def.description || '').replace(AUTO_NOTE_RE, '').trim();
      def.description = `${original ? `${original} ` : ''}Only populate when the document explicitly denominates this amount in ${currency}.`;
    }
  }

  for (const f of fields) {
    if (Array.isArray(f?.children) && f.children.length > 0) {
      normalizeContainer(f.children, [...path, f.name]);
    }
  }
}

/**
 * Locate currency-suffixed field groups without mutating the schema.
 * Used after normalization to know which data paths need reconciliation.
 */
export function findCurrencyFieldGroups(schema) {
  const groups = [];
  collectGroups(Array.isArray(schema) ? schema : [], [], groups);
  return groups;
}

function collectGroups(fields, path, out) {
  if (!Array.isArray(fields) || fields.length === 0) return;
  const names = new Set(fields.filter(f => f && typeof f.name === 'string').map(f => f.name));
  const byBase = new Map();
  for (const f of fields) {
    if (!isAmountDef(f)) continue;
    const suffix = currencySuffix(f.name);
    if (!suffix) continue;
    if (!byBase.has(suffix.base)) byBase.set(suffix.base, []);
    byBase.get(suffix.base).push({ name: f.name, currency: suffix.currency });
  }
  for (const [base, members] of byBase) {
    if (members.length < 2) continue;
    out.push({ path: [...path], base, neutral: base, neutralExists: names.has(base), members });
  }
  for (const f of fields) {
    if (Array.isArray(f?.children) && f.children.length > 0) {
      collectGroups(f.children, [...path, f.name], out);
    }
  }
}

function isFilled(value) {
  return value !== null && value !== undefined && String(value).trim() !== '';
}

function numeric(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const n = Number(value.replace(/[,\s]/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function sameAmount(a, b) {
  const na = numeric(a);
  const nb = numeric(b);
  if (na != null && nb != null) return Math.abs(na - nb) <= 0.005;
  return String(a) === String(b);
}

/** Visit every plain object reachable at `path` (arrays are traversed). */
function forEachObjectAtPath(root, path, fn) {
  const visit = (value, index) => {
    if (index === path.length) {
      if (Array.isArray(value)) {
        for (const item of value) {
          if (item && typeof item === 'object' && !Array.isArray(item)) fn(item);
        }
      } else if (value && typeof value === 'object' && !Array.isArray(value)) {
        fn(value);
      }
      return;
    }
    const next = value == null ? undefined : value[path[index]];
    if (Array.isArray(next)) {
      for (const item of next) visit(item, index + 1);
    } else {
      visit(next, index + 1);
    }
  };
  visit(root, 0);
}

/**
 * Canonicalize extracted amounts into the neutral field.
 *
 * - only one suffixed variant populated -> move it to the neutral field;
 * - several populated, one matches the document currency -> move that one;
 * - several populated and all equal -> move one;
 * - several genuinely different currencies -> leave untouched (no data loss);
 * - neutral already populated -> clear suffixed duplicates of the same value.
 */
export function reconcileCurrencyAmounts(data, groups, currencyValue) {
  const docCurrency = documentCurrencyCode(currencyValue);
  let moved = 0;
  let dropped = 0;
  if (!data || typeof data !== 'object' || !Array.isArray(groups) || groups.length === 0) {
    return { data, moved, dropped };
  }

  for (const group of groups) {
    if (!group || !group.neutralExists) continue;
    forEachObjectAtPath(data, group.path, (obj) => {
      const populated = group.members
        .map((member) => ({ ...member, value: obj[member.name] }))
        .filter((member) => isFilled(member.value));
      if (populated.length === 0) return;

      if (isFilled(obj[group.neutral])) {
        for (const member of populated) {
          if (sameAmount(member.value, obj[group.neutral])) {
            obj[member.name] = null;
            dropped += 1;
          }
        }
        return;
      }

      let source = null;
      if (docCurrency) source = populated.find((member) => member.currency === docCurrency) || null;
      if (!source && populated.length === 1) source = populated[0];
      if (!source && populated.every((member) => sameAmount(member.value, populated[0].value))) {
        source = populated[0];
      }
      if (!source) return;

      obj[group.neutral] = source.value;
      moved += 1;
      for (const member of populated) {
        if (member === source || sameAmount(member.value, source.value)) {
          obj[member.name] = null;
          dropped += 1;
        }
      }
    });
  }

  return { data, moved, dropped };
}
