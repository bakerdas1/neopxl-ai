import { convertToZodSchema } from './extractor/src/utils/convertToZodSchema.js';

const TOTAL_FIELD_RE = /total|grand|subtotal|amount_due|balance|payable|receivable|net_amount|gross_amount|net_total|gross_total/i;
const TOTAL_EXCLUDE_RE = /vat|tax|percent|pct|cgst|sgst|discount|rate|qty|quantity|weight|tons|kg|litres|liters/i;

const AMOUNT_FIELD_RE = /amount|total|price|value/i;
const AMOUNT_EXCLUDE_RE = /unit|per|rate|tariff|qty|quantity|count|tax|vat|discount|percent|pct|weight|tons|kg|litres|liters|passenger|hours?|minutes?|days?|date|time|duration/i;

const QTY_RE = /(^|_)(qty|quantity|units?|litres?|liters?|gallons?|kgs?|tons?)$/i;
const PRICE_RE = /(unit_price|price_per_unit|price|rate|tariff|charge_rate)/i;

export function collectTotalFields(fields, prefix = '') {
  const out = [];
  for (const f of fields || []) {
    if (f.type === 'array') continue;
    if (f.type === 'number' && TOTAL_FIELD_RE.test(f.name) && !TOTAL_EXCLUDE_RE.test(f.name)) {
      out.push(prefix ? `${prefix}.${f.name}` : f.name);
    }
    if (f.type === 'object' && Array.isArray(f.children)) {
      out.push(...collectTotalFields(f.children, prefix ? `${prefix}.${f.name}` : f.name));
    }
  }
  return out;
}

export function collectArrayFields(fields, prefix = '') {
  const out = [];
  for (const f of fields || []) {
    if (f.type === 'array' && Array.isArray(f.children) && f.children.length) {
      out.push({ name: prefix ? `${prefix}.${f.name}` : f.name, children: f.children });
    } else if (f.type === 'object' && Array.isArray(f.children)) {
      out.push(...collectArrayFields(f.children, prefix ? `${prefix}.${f.name}` : f.name));
    }
  }
  return out;
}

export function pickLineAmountField(children) {
  const num = (children || []).filter(c => c.type === 'number');
  const strong = num.filter(c => AMOUNT_FIELD_RE.test(c.name) && !AMOUNT_EXCLUDE_RE.test(c.name));
  if (strong.length) {
    strong.sort((a, b) => rankAmount(a.name) - rankAmount(b.name));
    return { type: 'field', name: strong[0].name };
  }
  const qty = num.find(c => QTY_RE.test(c.name));
  const price = num.find(c => PRICE_RE.test(c.name));
  if (qty && price) return { type: 'product', qty: qty.name, price: price.name };
  return null;
}

function rankAmount(name) {
  if (/amount/.test(name)) return 0;
  if (/total/.test(name)) return 1;
  return 2;
}

function toNum(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = parseFloat(v.replace(/[,\s$€£]/g, ''));
    return Number.isNaN(n) ? null : n;
  }
  return null;
}

function sumFor(items, spec) {
  let sum = 0;
  for (const it of items || []) {
    if (!it || typeof it !== 'object') continue;
    if (spec.type === 'product') {
      const q = toNum(it[spec.qty]);
      const p = toNum(it[spec.price]);
      if (q != null && p != null) sum += q * p;
    } else {
      const v = toNum(it[spec.name]);
      if (v != null) sum += v;
    }
  }
  return sum;
}

function getAt(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function setAt(obj, path, value) {
  const keys = path.split('.');
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (cur[keys[i]] == null || typeof cur[keys[i]] !== 'object') cur[keys[i]] = {};
    cur = cur[keys[i]];
  }
  cur[keys[keys.length - 1]] = value;
}

function approxEqual(a, b) {
  if (a == null || b == null) return false;
  const diff = Math.abs(a - b);
  return diff <= 0.02 || diff <= Math.abs(b) * 0.001;
}

function fmt(n) {
  if (n == null) return 'null';
  return typeof n === 'number' ? n.toFixed(2) : String(n);
}

function relevantArrays(totalName, arraySums) {
  const tokens = totalName.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 2);
  const matched = arraySums.filter(a => {
    const aTokens = a.name.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 2);
    return tokens.some(t => aTokens.includes(t));
  });
  return matched.length ? matched : arraySums;
}

export function buildTotalReport(data, totalPaths, arrays) {
  const arraySums = arrays.map(a => {
    const spec = pickLineAmountField(a.children);
    if (!spec) return null;
    const items = getAt(data, a.name) || [];
    return {
      name: a.name,
      label: spec.type === 'product' ? `the products of \`${spec.qty}\` × \`${spec.price}\`` : `\`${a.name}[].${spec.name}\``,
      sum: sumFor(items, spec),
      count: Array.isArray(items) ? items.length : 0,
    };
  }).filter(Boolean);

  if (!arraySums.length) return { report: '', needsFix: false };
  const anyItems = arraySums.some(s => s.count > 0);
  if (!anyItems) return { report: '', needsFix: false };

  const lines = [];
  for (const t of totalPaths) {
    const tval = toNum(getAt(data, t));
    const arrs = relevantArrays(t, arraySums);
    const combined = arrs.reduce((a, s) => a + s.sum, 0);
    const hasItems = arrs.some(s => s.count > 0);
    if (!hasItems) continue;

    if (tval == null) {
      lines.push(`- \`${t}\` is MISSING (null) in the extracted result, but the sum of its line items (${arrs.map(s => s.label).join(' + ')}) is ${fmt(combined)}. Locate the actual total in the document and fill it in.`);
      continue;
    }

    if (arrs.length === 1) {
      const s = arrs[0];
      if (s.count > 0 && !approxEqual(tval, s.sum)) {
        lines.push(`- \`${t}\` = ${fmt(tval)}, but the sum of ${s.label} = ${fmt(s.sum)}, difference ${fmt(Math.abs(tval - s.sum))}.`);
      }
    } else if (!approxEqual(tval, combined)) {
      lines.push(`- \`${t}\` = ${fmt(tval)}, but the combined sum of its line items (${arrs.map(s => s.label).join(' + ')}) = ${fmt(combined)}, difference ${fmt(Math.abs(tval - combined))}.`);
    }
  }

  return { report: lines.join('\n'), needsFix: lines.length > 0 };
}

export async function verifyTotals(markdown, data, schemaUsed, model, stats, fullZod, extract, maxReconciles = 2, opts = {}) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { data, reconciled: false };
  }
  const schema = Array.isArray(schemaUsed) ? schemaUsed : [];
  const totalPaths = collectTotalFields(schema);
  const arrays = collectArrayFields(schema);
  if (!totalPaths.length || !arrays.length) {
    return { data, reconciled: false };
  }

  let current = data;
  for (let i = 0; i <= maxReconciles; i++) {
    const { report, needsFix } = buildTotalReport(current, totalPaths, arrays);
    if (!needsFix) return { data: current, reconciled: i > 0 };
    if (i === maxReconciles) return { data: current, reconciled: i > 0 };

    const prompt = RECONCILE_PROMPT
      .replace('<<<DOCUMENT>>>', markdown)
      .replace('<<<SCHEMA>>>', JSON.stringify(schema, null, 2))
      .replace('<<<EXTRACTION>>>', JSON.stringify(current, null, 2))
      .replace('<<<REPORT>>>', report);

    try {
      const { data: corrected } = await extract(markdown, fullZod, model, stats, prompt);
      if (corrected && typeof corrected === 'object' && !Array.isArray(corrected)) {
        // Always protect non-empty line-item arrays: the reconcile pass exists to
        // fix TOTAL fields, not to re-extract rows. A full replace allows a
        // nondeterministic LLM re-emission to silently drop every row to [].
        current = mergeReconciled(corrected, current, arrays);
        console.info(`[verifyTotals] total mismatch found; Gemini revisited the document (round ${i + 1}).`);
      } else {
        return { data: current, reconciled: i > 0 };
      }
    } catch (e) {
      console.error('[verifyTotals] reconciliation failed:', e.message);
      return { data: current, reconciled: i > 0 };
    }
  }
  return { data: current, reconciled: maxReconciles > 0 };
}

function mergeReconciled(corrected, current, arrays) {
  const arrayNames = new Set((arrays || []).map(a => a.name));
  const merged = { ...current };
  for (const [k, v] of Object.entries(corrected || {})) {
    if (arrayNames.has(k) && Array.isArray(merged[k]) && merged[k].length > 0) continue;
    merged[k] = v;
  }
  return merged;
}

const RECONCILE_PROMPT = `You are a meticulous financial auditor reviewing an AI data extraction.

A document was previously processed and structured data was extracted against a schema. The extracted TOTAL AMOUNT field(s) do not reconcile with the sum of the extracted LINE ITEM amounts. Re-examine the ORIGINAL DOCUMENT, correct the extraction, and return the complete corrected JSON.

ORIGINAL DOCUMENT (Markdown):
<<<DOCUMENT>>>

OUTPUT SCHEMA (JSON field definitions):
<<<SCHEMA>>>

CURRENTLY EXTRACTED DATA (JSON):
<<<EXTRACTION>>>

DISCREPANCIES TO FIX:
<<<REPORT>>>

INSTRUCTIONS
1. Re-read the ORIGINAL DOCUMENT carefully. Verify every line item in the arrays — check that amounts were not misread, mis-typed, omitted, or duplicated.
2. Verify each TOTAL AMOUNT field was read from the correct location (header, footer, fine print, VAT/tax block, grand-total row).
3. Correct the data so that each total amount equals the sum of its line items. A total may equal the sum of one array or the combined sum of multiple arrays — determine the correct relationship from the document.
4. When a total and its line items disagree, prefer the sum of the explicitly listed line items, unless the document clearly states the authoritative total.
5. Preserve every other extracted value exactly as-is. Do not omit, rename, or restructure any schema field.
6. Return ONLY a single valid JSON object matching the schema — no markdown fences, no commentary.`;

const COVERAGE_TOLERANCE = 0;

export async function countRows(markdown, arrays, model, stats, extract) {
  if (!arrays || !arrays.length) return null;
  const countZod = convertToZodSchema(arrays.map(a => ({ name: a.name, type: 'number' })));
  const hints = arrays.map(a => `- "${a.name}": rows containing fields like ${(a.children || []).map(c => c.name).join(', ')}`).join('\n');
  const countPrompt = COVERAGE_COUNT_PROMPT.replace('<<<HINTS>>>', hints).replace('<<<DOCUMENT>>>', markdown);
  try {
    const { data: c } = await extract(markdown, countZod, model, stats, countPrompt);
    if (c && typeof c === 'object') return c;
  } catch (e) {
    console.error('[verifyCoverage] count pass failed:', e.message);
  }
  return null;
}

export async function verifyCoverage(markdown, data, schemaUsed, model, stats, fullZod, extract, maxReconciles = 2) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { data, adjusted: false, gap: null };
  const schema = Array.isArray(schemaUsed) ? schemaUsed : [];
  const arrays = collectArrayFields(schema);
  console.info(`[verifyCoverage] entered; arrays=${arrays.map(a => a.name).join(',') || '(none)'}`);
  if (!arrays.length) return { data, adjusted: false, gap: null };

  const counts = await countRows(markdown, arrays, model, stats, extract);
  console.info(`[verifyCoverage] count pass result: ${JSON.stringify(counts)}`);
  if (!counts) return { data, adjusted: false, gap: null };

  let current = data;
  for (let i = 0; i <= maxReconciles; i++) {
    const lines = [];
    const gap = {};
    for (const a of arrays) {
      const extracted = Array.isArray(getAt(current, a.name)) ? getAt(current, a.name).length : 0;
      const counted = counts[a.name];
      if (typeof counted !== 'number') continue;
      console.info(`[verifyCoverage] array=${a.name} extracted=${extracted} counted=${counted}`);
      if (Math.abs(extracted - counted) > COVERAGE_TOLERANCE) {
        lines.push(`- ${a.name}: expected ${counted} record(s), extracted ${extracted}.`);
        gap[a.name] = { expected: counted, actual: extracted };
      }
    }
    if (!lines.length) return { data: current, adjusted: i > 0, gap: null };
    if (i === maxReconciles) return { data: current, adjusted: i > 0, gap };

    const totalRows = arrays.reduce((s, a) => s + (Array.isArray(getAt(current, a.name)) ? getAt(current, a.name).length : 0), 0);
    if (totalRows > 500) {
      console.info(`[verifyCoverage] skipping repair: array too large (${totalRows} rows) — full re-emission would exceed output limits. Counts: ${JSON.stringify(counts)}`);
      return { data: current, adjusted: false, gap };
    }

    const prompt = COVERAGE_REPAIR_PROMPT
      .replace('<<<DOCUMENT>>>', markdown)
      .replace('<<<SCHEMA>>>', JSON.stringify(schema, null, 2))
      .replace('<<<EXTRACTION>>>', JSON.stringify(current, null, 2))
      .replace('<<<REPORT>>>', lines.join('\n'));

    try {
      const { data: corrected } = await extract(markdown, fullZod, model, stats, prompt);
      if (corrected && typeof corrected === 'object' && !Array.isArray(corrected)) {
        const prev = current;
        current = corrected;
        // Never let a repair wipe a non-empty array down to zero rows.
        for (const a of arrays) {
          const newArr = getAt(current, a.name);
          const oldArr = getAt(prev, a.name);
          if (Array.isArray(newArr) && newArr.length === 0 && Array.isArray(oldArr) && oldArr.length > 0) {
            setAt(current, a.name, oldArr);
          }
        }
        for (const a of arrays) {
          const len = Array.isArray(getAt(current, a.name)) ? getAt(current, a.name).length : 0;
          console.info(`[verifyCoverage] after repair array=${a.name} length=${len} counted=${counts[a.name]}`);
        }
        console.info(`[verifyCoverage] coverage mismatch found; Gemini re-extracted the records (round ${i + 1}).`);
      } else {
        return { data: current, adjusted: i > 0, gap };
      }
    } catch (e) {
      console.error('[verifyCoverage] repair failed:', e.message);
      return { data: current, adjusted: i > 0, gap };
    }
  }
  return { data: current, adjusted: maxReconciles > 0, gap: null };
}

const COVERAGE_COUNT_PROMPT = `You are a meticulous document auditor. Count the EXACT number of individual data records (rows / line items) present in the document for each category below.

RULES
- Count every single record. Never skip rows, even when they repeat across page boundaries or pages break mid-table.
- Do NOT count headers, table titles, footers, signature lines, subtotal/total/summary rows, or grouping labels.
- Do NOT count "continued on next page" style placeholders.
- If a category has no records at all, return 0.
- Provide the final count as an integer for every category listed.

CATEGORIES TO COUNT:
<<<HINTS>>>

DOCUMENT (Markdown):
<<<DOCUMENT>>>

Return ONLY a JSON object with an integer count for every category. No commentary.`;

const COVERAGE_REPAIR_PROMPT = `You previously extracted structured data from a document. A coverage audit directly counted the records in the DOCUMENT and found that some of your arrays contain the WRONG number of records (some records were missed or duplicated). Re-examine the document and return the complete corrected JSON.

DOCUMENT (Markdown):
<<<DOCUMENT>>>

OUTPUT SCHEMA (JSON field definitions):
<<<SCHEMA>>>

CURRENTLY EXTRACTED DATA (JSON):
<<<EXTRACTION>>>

AUDIT FINDINGS (array: expected record count vs extracted count):
<<<REPORT>>>

INSTRUCTIONS
1. Re-read the DOCUMENT and re-extract every affected array so it contains EXACTLY the expected number of records.
2. Include every record in full — do not skip, merge, truncate, or summarise rows.
3. Remove any accidental duplicate records.
4. Keep every other field identical to the CURRENTLY EXTRACTED DATA.
5. Return ONLY a single valid JSON object matching the schema — no markdown fences, no commentary.`;

const COVERAGE_PAGE_COUNT_PROMPT = `You are a meticulous document auditor. Count the EXACT number of individual data records (rows / line items) present on the CURRENT page below for each category.

RULES
- The text above the "===== CURRENT PAGE BELOW =====" marker is the TAIL of the PREVIOUS page, shown only as context. If there is NO marker in the text, ignore this rule.
- Count every record that is FULLY or PARTIALLY below the marker. Records FULLY above the marker belong to the PREVIOUS page — do NOT count them.
- If a record is SPLIT ACROSS the marker (some of its values appear above the marker, the rest below), it is ONE record — count it exactly once.
- Never skip rows, even when a table continues across pages or a page break falls mid-row.
- Do NOT count headers, table titles, footers, signature lines, subtotal/total/summary rows, or grouping labels.
- If a category has no records on this page, return 0.
- Provide the final count as an integer for every category listed.

CATEGORIES TO COUNT:
<<<HINTS>>>

DOCUMENT (Markdown):
<<<DOCUMENT>>>

Return ONLY a JSON object with an integer count for every category. No commentary.`;

const COVERAGE_PAGE_REPAIR_PROMPT = `You extracted the data records present on ONE page of a multi-page document. A coverage audit counted the records on this page and found the wrong number of records were extracted. Re-examine the page and return the corrected JSON.

PAGE (Markdown):
<<<DOCUMENT>>>

OUTPUT ARRAYS (JSON field definitions):
<<<ARRAYS>>>

CURRENTLY EXTRACTED ARRAYS (JSON):
<<<EXTRACTED>>>

AUDIT FINDINGS (array: expected record count vs extracted count):
<<<REPORT>>>

INSTRUCTIONS
1. Re-read the PAGE and re-extract the affected array so it contains EXACTLY the expected number of records.
2. Include every record in full — do not skip, merge, truncate, or summarise rows.
3. Remove any accidental duplicate records.
4. Records FULLY above the "===== CURRENT PAGE BELOW =====" marker belong to the PREVIOUS page — do NOT include them. A record SPLIT ACROSS the marker is ONE record that continues onto this page — include it once, complete, with all visible values.
5. Keep every other extracted value identical.
6. Return ONLY a single valid JSON object containing the arrays — no markdown fences, no commentary.`;

export async function verifyCoveragePerPage(inputs, arrayResults, arrays, model, stats, arrayZod, extract) {
  let adjusted = false;
  const pageCounts = {};
  const countZod = convertToZodSchema(arrays.map(a => ({ name: a.name, type: 'number' })));
  const hints = arrays.map(a => `- "${a.name}": rows containing fields like ${(a.children || []).map(c => c.name).join(', ')}`).join('\n');
  for (let i = 0; i < inputs.length; i++) {
    const input = inputs[i];
    const countPrompt = COVERAGE_PAGE_COUNT_PROMPT.replace('<<<HINTS>>>', hints).replace('<<<DOCUMENT>>>', input);
    let counts = null;
    try {
      const { data: c } = await extract(input, countZod, model, stats, countPrompt);
      if (c && typeof c === 'object') counts = c;
    } catch (e) {
      console.error(`[verifyCoverage] page ${i + 1} count pass failed:`, e.message);
      continue;
    }
    if (!counts) continue;
    pageCounts[i] = counts;

    const lines = [];
    for (const a of arrays) {
      const extracted = Array.isArray(arrayResults[i].data?.[a.name]) ? arrayResults[i].data[a.name].length : 0;
      const counted = counts[a.name];
      if (typeof counted !== 'number' || extracted === counted) continue;
      console.info(`[verifyCoverage] page ${i + 1}: array=${a.name} extracted=${extracted} counted=${counted}`);
      lines.push(`- ${a.name}: expected ${counted} record(s), extracted ${extracted}.`);
    }
    if (!lines.length) continue;

    adjusted = true;
    const repairPrompt = COVERAGE_PAGE_REPAIR_PROMPT
      .replace('<<<DOCUMENT>>>', input)
      .replace('<<<ARRAYS>>>', JSON.stringify(arrays, null, 2))
      .replace('<<<EXTRACTED>>>', JSON.stringify(Object.fromEntries(arrays.map(a => [a.name, arrayResults[i].data?.[a.name] || []])) , null, 2))
      .replace('<<<REPORT>>>', lines.join('\n'));
    try {
      const { data: corrected } = await extract(input, arrayZod, model, stats, repairPrompt);
      if (corrected && typeof corrected === 'object') {
        arrayResults[i].data = corrected;
        for (const a of arrays) {
          console.info(`[verifyCoverage] page ${i + 1} after repair: array=${a.name} length=${Array.isArray(corrected[a.name]) ? corrected[a.name].length : 0}`);
        }
        console.info(`[verifyCoverage] page ${i + 1} coverage repair applied.`);
      }
    } catch (e) {
      console.error(`[verifyCoverage] page ${i + 1} repair failed:`, e.message);
    }
  }
  return { adjusted, pageCounts };
}
