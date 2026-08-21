import { createServer } from 'http';
import { writeFile, mkdtemp, rm } from 'fs/promises';
import { readFileSync } from 'fs';
import { join, extname } from 'path';
import { dirname } from 'path';
import { fileURLToPath } from 'url';
const __dirname = dirname(fileURLToPath(import.meta.url));
import { tmpdir } from 'os';
import crypto from 'crypto';
import pLimit from 'p-limit';
import { loadStore, addJob, updateJob, getStats, getJobs, getJobCards, getJobCounts, getTemplates, addTemplate, updateTemplate, deleteTemplate, getUsers, getUserByEmail, addUser, updateUser, deleteUser, getCompanies, addCompany, updateCompany, deleteCompany, createApiKey, getUserApiKeys, revokeApiKey, getApiKeyUser, deleteJob, markOrphanedJobsAsError, getJobResultData, getSetting, setSetting } from './store.mjs';
import { hashPassword, comparePassword, signToken, verifyToken, authGuard } from './auth.mjs';
import 'dotenv/config';
import { documind } from 'core';
import { generateMarkdownDocument } from './extractor/src/utils/generateMarkdown.js';
import { convertToZodSchema } from './extractor/src/utils/convertToZodSchema.js';
import { getExtractor } from './extractor/src/extractors/index.js';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { BASE_EXTRACTION_PROMPT } from './extractor/src/prompts.js';
import { verifyTotals, verifyCoverage, verifyCoveragePerPage, countRows } from './verifyTotals.mjs';
import { templates } from './extractor/src/services/templates.js';
import { generateSchema } from './schema-service/generateSchema.js';
import { initDb, closeDb } from './db.mjs';
import { loadStorageConfig, getStorageConnectors, getStorageConnector, addStorageConnector, deleteStorageConnector, setActiveStorageConnector, putJobFiles, openJobFile, testS3Connection, deleteJobFiles } from './storage.mjs';
import { buildCsvExport } from './csvExport.mjs';

const PORT = 3022;
const ALLOWED = ['pdf', 'png', 'jpg', 'jpeg', 'txt', 'docx', 'html', 'xlsx', 'xls', 'csv'];
const SCHEMA_ALLOWED = ['pdf', 'docx', 'png', 'jpg', 'jpeg', 'xlsx', 'xls', 'csv'];
const MAX_SCHEMA_FILES = 10;

// Default domain profiles and prompt templates. These are overridable at runtime
// via app_settings (editable under AI Settings) — nothing here is a hard contract.
const DEFAULT_DOMAINS = {
  aviation: {
    label: 'Aviation',
    prompt: '',
    chargeTypeAliases: {
      'LANDING FEES': ['^landing', '^atterrissage', '^diritto approdo', '^aterrizaje'],
      'TAKE OFF FEES': ['^take[- ]?off', '^takeoff', '^decollo'],
    },
    movementPattern: { flightPrefix: '[A-Z0-9]{2,3}', runwayKeyword: 'RWY', defaultAirport: null },
    fieldVocabulary: {
      flight_number: "\\b(?=[A-Z0-9]{0,3}[A-Z])[A-Z0-9]{2,3}\\s?\\d{2,4}(?:/[A-Z])?\\b(?![-.]\\d)",
      aircraft_registration: "\\b(?:A6[A-Z]{3}|[A-Z]{5}|\\d[A-Z]{3}|[A-Z]{4})\\b",
      date: "\\b\\d{1,2}[-./]\\d{1,2}(?:[-./]\\d{2,4})?\\b",
      time: "\\b\\d{1,2}:\\d{2}\\b",
      origin: "\\b[A-Z]{4}\\b",
      destination: "\\b[A-Z]{4}\\b",
    },
  },
  generic: { label: 'Generic', prompt: '', chargeTypeAliases: {}, movementPattern: null, fieldVocabulary: {} },
};

const DEFAULT_CLASSIFY_PROMPT = `You are a document classifier. Analyze the document and determine which single template below best matches it.

AVAILABLE TEMPLATES:
{{TEMPLATES}}

RULES:
- Choose the template whose name, description, and keywords best match the document's content and structure.
- Do NOT guess from generic words like "amount", "quantity", "date", or "total" — those appear in most documents.
- If no template clearly matches, return Unknown.
- Do NOT fabricate a template id — only use ids from the list above.

Return ONLY the template id (e.g., np_001) or the word Unknown.`;

// Runtime AI configuration cache (base prompt, classify prompt, domains).
let _aiConfig = null;
function getAiConfig() {
  return _aiConfig || { basePrompt: BASE_EXTRACTION_PROMPT, classifyPrompt: DEFAULT_CLASSIFY_PROMPT, domains: DEFAULT_DOMAINS };
}
async function loadAiConfig() {
  const [base, classify, domains] = await Promise.all([
    getSetting('ai.base_prompt'),
    getSetting('ai.classify_prompt'),
    getSetting('domains'),
  ]);
  _aiConfig = {
    basePrompt: typeof base === 'string' && base.trim() ? base : BASE_EXTRACTION_PROMPT,
    classifyPrompt: typeof classify === 'string' && classify.trim() ? classify : DEFAULT_CLASSIFY_PROMPT,
    domains: domains && typeof domains === 'object' && !Array.isArray(domains) ? domains : DEFAULT_DOMAINS,
  };
  return _aiConfig;
}

const MIME = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  txt: 'text/plain; charset=utf-8',
  html: 'text/html; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  csv: 'text/csv; charset=utf-8',
};
const jobs = new Map();
const schemaJobs = new Map();

async function persistJobFiles(jobId, files) {
  return putJobFiles(jobId, files);
}

function getBoundary(contentType) {
  const m = contentType?.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  return (m?.[1] || m?.[2])?.trim();
}

function sendJSON(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data));
}

function authFromQuery(url, res) {
  const tok = url.searchParams.get('token');
  if (!tok) return null;
  try { return verifyToken(tok); } catch { return null; }
}

function jsonSchemaToDocumind(obj) {
  if (Array.isArray(obj)) return obj;
  if (obj.name !== undefined && obj.type) return obj;
  const props = obj.properties;
  if (props && typeof props === 'object') {
    const req = Array.isArray(obj.required) ? obj.required : null;
    return Object.entries(props).map(([name, def]) => {
      const field = { name, type: def.type || 'string' };
      if (def.description) field.description = def.description;
      if (def.format) field.format = def.format;
      if (req) field.required = req.includes(name);
      if (def.properties) field.children = jsonSchemaToDocumind(def);
      if (def.type === 'array' && def.items) {
        field.children = jsonSchemaToDocumind(def.items);
        if (field.children.length === 0) field.children = undefined;
      }
      return field;
    });
  }
  return null;
}

const DATE_MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const DATE_MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function isDateField(field) {
  if (!field || typeof field !== 'object') return false;
  if (field.type && field.type !== 'string') return false;
  const name = field.name || '';
  const fmt = field.format || '';
  if (/\bdate\b/i.test(name.replace(/[_-]/g, ' '))) return true;
  if (/(?<=[a-z])Date/.test(name)) return true;
  if (/date/i.test(fmt)) return true;
  if (/[YD]/.test(fmt)) return true;
  return false;
}

function dateFieldPaths(fields, prefix = []) {
  const paths = [];
  for (const f of fields || []) {
    if (!f || typeof f !== 'object') continue;
    const path = [...prefix, f.name];
    if (f.children && Array.isArray(f.children) && f.children.length) {
      paths.push(...dateFieldPaths(f.children, path));
    } else if (isDateField(f)) {
      paths.push({ path, hint: f.format || '' });
    }
  }
  return paths;
}

function parseDateParts(value, hint = '') {
  if (value == null) return null;
  let s = String(value).trim().replace(/[Tt]/g, ' ');
  if (!s) return null;
  const timeMatch = s.match(/\d{1,2}:\d{2}(:\d{2})?\s*(AM|PM)?/i);
  if (timeMatch) s = s.slice(0, timeMatch.index).trim();
  if (!s) return null;
  const months = { jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12 };
  let month = null;
  const monMatch = s.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*/i);
  if (monMatch) month = months[monMatch[1].toLowerCase()];
  const nums = (s.match(/\d+/g) || []).map(Number);
  if (nums.length < 2) return null;
  let year = null;
  const yearFirst = /^Y/i.test(hint);
  const yearLeading = /^\s*\d{4}[-\/.\s]/.test(s);
  for (let i = 0; i < nums.length; i++) {
    if (nums[i] > 1000 && nums[i] < 3000) { year = nums[i]; nums.splice(i, 1); break; }
  }
  if (year === null) {
    if (nums.length >= 3) year = 2000 + nums.pop();
    else return null;
  }
  let day = null;
  if (month !== null) {
    day = nums[0];
  } else if (nums.length >= 2) {
    let a = nums[0], b = nums[1];
    if (a > 12) { day = a; month = b; }
    else if (b > 12) { month = a; day = b; }
    else if (yearFirst || yearLeading) { month = a; day = b; }
    else if (/^D/i.test(hint)) { day = a; month = b; }
    else if (/^M/i.test(hint)) { month = a; day = b; }
    else { day = a; month = b; }
  } else return null;
  if (!month || !day || month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { year, month, day };
}

function renderDate(parts, format) {
  if (!parts || !format) return null;
  const { year, month, day } = parts;
  const pad = n => String(n).padStart(2, '0');
  const tokens = {
    YYYY: String(year),
    YY: String(year).slice(-2),
    MMMM: DATE_MONTHS[month - 1],
    MMM: DATE_MONTHS_SHORT[month - 1],
    MM: pad(month),
    M: String(month),
    DD: pad(day),
    D: String(day),
  };
  return format.replace(/YYYY|YY|MMMM|MMM|MM|DD|D|M/g, t => tokens[t] ?? t);
}

function reformatDate(value, format, hint = '') {
  const parts = parseDateParts(value, hint);
  if (!parts) return null;
  return renderDate(parts, format);
}

function applyDateFormats(data, paths, format) {
  for (const p of paths) {
    const path = p.path || p;
    const hint = p.hint || '';
    const setAt = (node, idx) => {
      if (node == null || typeof node !== 'object') return;
      if (idx === path.length - 1) {
        const val = node[path[idx]];
        if (typeof val === 'string' && val.trim()) {
          const formatted = reformatDate(val, format, hint);
          if (formatted !== null) node[path[idx]] = formatted;
        }
        return;
      }
      const next = node[path[idx]];
      if (Array.isArray(next)) {
        for (const item of next) setAt(item, idx + 1);
      } else if (next && typeof next === 'object') {
        setAt(next, idx + 1);
      }
    };
    setAt(data, 0);
  }
  return data;
}

function fixDatesFromSource(markdown, data, paths, inputFormat, outputFormat) {
  if (!markdown || !data || typeof data !== 'object') return data;
  markdown = String(markdown).replace(/<br\s*\/?>/gi, ' ');
  const lines = markdown.split('\n');
  const isDayFirst = /^DD/i.test(inputFormat || '');
  const findDateFor = row => {
    if (!row || typeof row !== 'object') return null;
    const fl = String(row.flight_number || row.flight_no || row.flight || row.movement_number || '').replace(/\s/g, '');
    if (!fl) return null;
    const times = [row.ata, row.atd, row.time, row.movement_time].filter(t => t && /^\d{1,2}:\d{2}/.test(String(t)));
    for (const line of lines) {
      if (!line.replace(/\s/g, '').includes(fl)) continue;
      if (times.length && !times.some(t => line.includes(String(t)))) continue;
      const m = line.match(/\b(\d{1,2})[.\-\/](\d{1,2})[.\-\/](\d{4})\b/);
      if (m) {
        const a = +m[1], b = +m[2], y = +m[3];
        const day = isDayFirst ? a : b;
        const month = isDayFirst ? b : a;
        if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
          return renderDate({ year: y, month, day }, outputFormat);
        }
      }
    }
    return null;
  };
  for (const p of paths) {
    const path = p.path || p;
    const setAt = (node, idx) => {
      if (node == null || typeof node !== 'object') return;
      if (idx === path.length - 1) {
        if (typeof node[path[idx]] === 'string') {
          const fixed = findDateFor(node);
          if (fixed) node[path[idx]] = fixed;
        }
        return;
      }
      const next = node[path[idx]];
      if (Array.isArray(next)) {
        for (const item of next) setAt(item, idx + 1);
      } else if (next && typeof next === 'object') {
        setAt(next, idx + 1);
      }
    };
    setAt(data, 0);
  }
  return data;
}

function parseFilterConfig(str) {
  if (!str || typeof str !== 'string') return null;
  let parsed = null;
  try { parsed = JSON.parse(str); } catch { return null; }
  while (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed); } catch { break; }
  }
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
}

function normalizeChargeTypes(data, aliases) {
  if (!data || typeof data !== 'object') return data;
  const matchers = [];
  if (aliases && typeof aliases === 'object') {
    for (const [canonical, variants] of Object.entries(aliases)) {
      const list = Array.isArray(variants) ? variants : [variants];
      for (const v of list) {
        if (typeof v === 'string' && v) matchers.push({ canonical, re: new RegExp(v, 'i') });
      }
    }
  }
  if (!matchers.length) return data;
  const walk = node => {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (!node || typeof node !== 'object') return;
    if (typeof node.charges_type === 'string') {
      const t = node.charges_type.trim();
      for (const m of matchers) { if (m.re.test(t)) { node.charges_type = m.canonical; break; } }
    }
    Object.values(node).forEach(walk);
  };
  walk(data);
  return data;
}

function canonicalizeMovements(data, markdown) {
  if (!data || typeof data !== 'object') return data;
  markdown = String(markdown || '').replace(/<br\s*\/?>/gi, ' ');
  const lines = markdown ? markdown.split('\n') : [];
  const pick = r => {
    for (const f of ['flight_number', 'flight_no', 'flight', 'movement_number']) {
      const v = r[f];
      if (v !== undefined && v !== null && String(v).trim() !== '' && String(v).trim().toLowerCase() !== 'null') return String(v).trim();
    }
    return null;
  };
  const dateOf = r => {
    for (const f of ['date', 'movement_date', 'flight_date', 'landing_date']) {
      const v = r[f];
      if (v !== undefined && v !== null && String(v).trim() !== '' && String(v).trim().toLowerCase() !== 'null') return String(v).trim();
    }
    return null;
  };
  const timeOf = r => {
    for (const f of ['ata', 'atd', 'movement_time', 'time', 'departure_time', 'arrival_time']) {
      const v = r[f];
      if (v !== undefined && v !== null && String(v).trim() !== '' && String(v).trim().toLowerCase() !== 'null') {
        const m = String(v).match(/\d{1,2}:\d{2}/);
        if (m) return m[0];
      }
    }
    return null;
  };
  const typeOf = r => {
    for (const f of ['charges_type', 'charge_type', 'type']) {
      const v = r[f];
      if (v !== undefined && v !== null && String(v).trim() !== '' && String(v).trim().toLowerCase() !== 'null') return String(v).trim();
    }
    return null;
  };
  const completeness = r => Object.keys(r).filter(k => {
    const v = r[k];
    return v !== undefined && v !== null && String(v).trim() !== '' && String(v).trim().toLowerCase() !== 'null';
  }).length;
  const findSourceTime = (fl, date) => {
    const flat = fl.replace(/\s+/g, '');
    const dm = String(date).match(/^(\d{2})-(\d{2})-(\d{4})$/);
    if (!dm) return null;
    const matches = [];
    for (const line of lines) {
      if (!line.replace(/\s+/g, '').includes(flat)) continue;
      const dmatch = line.match(/\b(\d{1,2})[.\-\/](\d{1,2})[.\-\/](\d{4})\b/);
      if (!dmatch) continue;
      const y = +dmatch[3], mo = +dmatch[2], dd = +dmatch[1];
      if (y !== +dm[3] || mo !== +dm[2] || dd !== +dm[1]) continue;
      const t = line.match(/\b(\d{1,2}):(\d{2})\b/);
      matches.push({ line, time: t ? t[0] : null });
    }
    if (matches.length === 1) return matches[0].time;
    return null;
  };
  const bestOf = rows => {
    if (rows.length === 1) return rows[0];
    const types = {};
    for (const r of rows) { const t = typeOf(r) || '(none)'; types[t] = (types[t] || 0) + 1; }
    const top = Object.entries(types).sort((a, b) => b[1] - a[1]);
    const fl = pick(rows[0]) || '';
    const suffixA = /\/A$/i.test(fl);
    const suffixD = /\/D$/i.test(fl);
    if (top.length > 1 && top[0][1] === top[1][1] && (suffixA || suffixD)) {
      const prefer = suffixA ? /landing/i : /take\s?-?off/i;
      const favored = rows.find(r => prefer.test(typeOf(r) || ''));
      if (favored) return favored;
    }
    return rows.sort((a, b) => completeness(b) - completeness(a))[0];
  };
  const processArray = arr => {
    const out = [];
    const groups = new Map();
    for (const r of arr) {
      if (!r || typeof r !== 'object') { out.push(r); continue; }
      const fl = pick(r), date = dateOf(r);
      if (!fl || !date) { out.push(r); continue; }
      const key = `${fl}|${date}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    }
    for (const [key, rows] of groups) {
      const [fl, date] = key.split('|');
      const correctedTime = findSourceTime(fl, date);
      if (correctedTime) {
        const best = bestOf(rows);
        if ('atd' in best) best.atd = correctedTime;
        if ('ata' in best) best.ata = correctedTime;
        out.push(best);
        continue;
      }
      const timeGroups = new Map();
      for (const r of rows) {
        const t = timeOf(r) || '';
        if (!timeGroups.has(t)) timeGroups.set(t, []);
        timeGroups.get(t).push(r);
      }
      const times = [...timeGroups.keys()];
      const timed = times.filter(t => t !== '');
      const noTimeRows = timeGroups.get('') || [];
      if (noTimeRows.length) {
        timeGroups.delete('');
        if (timed.length === 1) timeGroups.get(timed[0]).push(...noTimeRows);
        else for (let i = 0; i < noTimeRows.length; i++) timeGroups.set(`?${out.length}_${i}`, [noTimeRows[i]]);
      }
      for (const [, trows] of timeGroups) out.push(bestOf(trows));
    }
    return out;
  };
  const walk = node => {
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) walk(node[i]);
      return;
    }
    if (!node || typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node)) {
      if (Array.isArray(v)) node[k] = processArray(v);
      else if (v && typeof v === 'object') walk(v);
    }
  };
  walk(data);
  return data;
}

function normalizeMarkdown(md) {
  return String(md || '').replace(/<br\s*\/?>/gi, ' ').replace(/\*\*/g, '');
}

function parseAmountGeneric(s) {
  const t = String(s ?? '').replace(/\*\*/g, '').trim();
  const m = t.match(/\d[\d.,]*/);
  if (!m) return null;
  const raw = m[0];
  const ci = raw.lastIndexOf(',');
  const di = raw.lastIndexOf('.');
  let n;
  if (ci >= 0 && di >= 0) {
    n = ci > di ? raw.replace(/\./g, '').replace(',', '.') : raw.replace(/,/g, '');
  } else if (ci >= 0) {
    n = raw.slice(ci + 1).length <= 2 ? raw.replace(',', '.') : raw.replace(/,/g, '');
  } else if (di >= 0) {
    n = raw;
  } else {
    n = raw.length >= 4 ? raw.slice(0, -2) + '.' + raw.slice(-2) : raw;
  }
  const v = parseFloat(n);
  return Number.isFinite(v) ? v : null;
}

function formatDateGeneric(d, year, dateFormat) {
  const m = String(d ?? '').match(/^(\d{1,2})[-./](\d{1,2})(?:[-./](\d{2,4}))?$/);
  if (!m) return d || null;
  const dd = +m[1], mm = +m[2];
  let y = m[3] ? +m[3] : (year || null);
  if (y && y < 100) y += 2000;
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return d;
  return renderDate({ year: y, month: mm, day: dd }, dateFormat || 'DD-MM-YYYY');
}

function cleanChargeName(n) {
  return String(n ?? '').replace(/^\s*[A-Z0-9]\s+/, '').replace(/^\s*(?:[A-Z]{3}\s+)+/, '').trim();
}

// Generic, schema/domain-driven record extractor. Replaces the previous per-layout
// parsers. It locates record rows (a line with a flight number + a registration + a date),
// then associates amount/description charges with the nearest preceding record whose
// direction matches (landing → arrival, take-off → departure). All field patterns and
// charge-type names come from config (domain fieldVocabulary + chargeTypeAliases).
function extractRecords(markdown, chargeAliases, vocab, dateFormat) {
  const lines = normalizeMarkdown(markdown).split('\n');
  const year = String(markdown).match(/\b(20\d{2})\b/)?.[1] || null;
  const v = vocab || {};
  const flightRe = new RegExp(v.flight_number || "\\b(?=[A-Z0-9]{0,3}[A-Z])[A-Z0-9]{2,3}\\s?\\d{2,4}(?:/[A-Z])?\\b(?![-.]\\d)", 'g');
  const regRe = new RegExp(v.aircraft_registration || "\\b(?:A6[A-Z]{3}|[A-Z]{5}|\\d[A-Z]{3}|[A-Z]{4})\\b");
  const dateRe = new RegExp(v.date || "\\b\\d{1,2}[-./]\\d{1,2}(?:[-./]\\d{2,4})?\\b", 'g');
  // Recover dates whose separators were dropped by the converter, e.g. "2162026" → "21-6-2026".
  const degradedDateRe = /\b(\d{1,2})(\d{1,2})((?:19|20)\d{2})\b/g;
  const collectDates = line => {
    const out = [];
    for (const m of line.matchAll(dateRe)) out.push(m[0]);
    for (const m of line.matchAll(degradedDateRe)) {
      const d = +m[1], mo = +m[2], y = +m[3];
      if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) out.push(`${d}-${mo}-${y}`);
    }
    return out;
  };
  const timeRe = new RegExp(v.time || "\\b\\d{1,2}:\\d{2}\\b");
  const icaoRe = new RegExp(v.origin || "\\b[A-Z]{4}\\b", 'g');
  // Monetary amounts only (decimal + 2 digits, not followed by a digit or dot) — avoids
  // matching serial numbers ("1.952.449") and dates ("22.07.") as amounts.
  const amountRe = /(\d[\d,]*(?:\.\d{2}|,\d{2}))(?![\d.])/g;
  const feeTypes = Object.entries(chargeAliases || {}).map(([name, variants]) => ({
    name,
    re: new RegExp((Array.isArray(variants) ? variants : [variants]).map(x => String(x).replace(/^\^/, '')).map(x => '(' + x + ')').join('|'), 'i'),
    isTakeoff: /take/i.test(name),
  }));

  const out = [];
  let lastArrival = null, lastDeparture = null, stopCharges = false;
  const pushNameCharges = t => {
    const nameRe = /([A-Za-z][A-Za-z .&/-]{2,30}?)\s*:/g;
    const names = [...t.matchAll(nameRe)].map(m => cleanChargeName(m[1])).filter(n => n.length > 2);
    const amts = [...t.matchAll(amountRe)].map(m => m[0]);
    if (!names.length || !amts.length) return false;
    for (let i = 0; i < names.length && i < amts.length; i++) {
      const amt = parseAmountGeneric(amts[i]);
      if (!amt) continue;
      const isTakeoff = /take\s?-?off|takeoff/i.test(names[i]);
      const mov = isTakeoff ? lastDeparture : lastArrival;
      if (!mov) continue;
      out.push({ flight_number: isTakeoff ? mov.departure : mov.arrival, aircraft_registration: mov.reg, date: formatDateGeneric(mov.date, year, dateFormat), origin: mov.origin, net_amount: amt, base_amount: amt, description: names[i], charges_type: names[i], ata: isTakeoff ? null : mov.time, atd: isTakeoff ? mov.time : null, airport: null });
    }
    return true;
  };
  for (const line of lines) {
    const t = line.trim();
    if (!t.startsWith('|') || !t.endsWith('|')) continue;
    if (stopCharges) continue;
    // Summary / grand-total section marker — stop associating charges past it.
    if (/(riepilogo|grand[- ]?total|\btotal\b)/i.test(t) && (lastArrival || lastDeparture)) {
      stopCharges = true;
      continue;
    }
    const flights = [...t.matchAll(flightRe)].map(m => m[0].replace(/\s+/g, ' ').toUpperCase());
    const reg = t.match(regRe);
    const dates = collectDates(t);
    if (flights.length && reg && dates.length) {
      const hasSuffix = flights.some(f => /\/[AD]$/.test(f));
      const arrival = hasSuffix ? (flights.find(f => /\/A$/.test(f)) || null) : (flights[0] || null);
      const departure = hasSuffix ? (flights.find(f => /\/D$/.test(f)) || null) : (flights[1] || null);
      const cells = t.slice(1, -1).split('|').map(c => c.trim()).filter(c => c !== '');
      const lastCell = cells[cells.length - 1];
      const inRowVal = parseAmountGeneric(lastCell);
      const inRow = (/[.,]/.test(lastCell) || (inRowVal != null && inRowVal > 200)) ? inRowVal : null;
      const icaos = [...t.matchAll(icaoRe)].map(m => m[0]).filter(x => x !== reg[0]);
      const mov = { arrival, departure, reg: reg[0], date: dates[0], time: t.match(timeRe)?.[0] || null, origin: icaos[0] || null };
      if (arrival) lastArrival = mov;
      if (departure) lastDeparture = mov;
      if (inRow && inRow > 1) {
        out.push({ flight_number: arrival, aircraft_registration: mov.reg, date: formatDateGeneric(mov.date, year, dateFormat), origin: mov.origin, net_amount: inRow, base_amount: inRow, description: null, charges_type: null, ata: null, atd: null, airport: null });
      }
      // Charges may be interleaved into a record row (transposed header+charges) — extract them too.
      pushNameCharges(t);
      continue;
    }
    if (pushNameCharges(t)) continue;
    for (const ft of feeTypes) {
      if (!ft.re.test(t)) continue;
      const amts = [...t.matchAll(amountRe)].map(m => parseAmountGeneric(m[0])).filter(x => x && x > 1);
      if (!amts.length) continue;
      const amt = amts[amts.length - 1];
      const mov = ft.isTakeoff ? lastDeparture : lastArrival;
      if (!mov) continue;
      out.push({ flight_number: ft.isTakeoff ? mov.departure : mov.arrival, aircraft_registration: mov.reg, date: formatDateGeneric(mov.date, year, dateFormat), origin: mov.origin, net_amount: amt, base_amount: amt, description: ft.name, charges_type: ft.name, ata: ft.isTakeoff ? null : mov.time, atd: ft.isTakeoff ? mov.time : null, airport: null });
      break;
    }
  }
  return out;
}

function reconcileMovementRows(markdown, data, arraySchema, dateInputFormat, dateFormat, pattern = {}, chargeAliases, vocab) {
  if (!markdown || !data || typeof data !== 'object') return data;
  const records = extractRecords(markdown, chargeAliases, vocab, dateFormat);
  if (records.length < 10) return data;
  const arrays = (arraySchema || []).filter(a => a.type === 'array' && Array.isArray(a.children) && a.children.length);
  if (!arrays.length) return data;
  const airportFrom = rows => {
    const counts = new Map();
    for (const r of rows) {
      const a = r?.airport;
      if (!a || String(a).trim() === '' || String(a).trim().toLowerCase() === 'null') continue;
      counts.set(String(a).trim(), (counts.get(String(a).trim()) || 0) + 1);
    }
    let mode = null, mc = 0;
    for (const [val, c] of counts) {
      if (/s\.p\.a|marconi/i.test(val)) continue;
      if (c > mc) { mode = val; mc = c; }
    }
    return mode || (pattern && pattern.defaultAirport) || null;
  };
  for (const arr of arrays) {
    if (!(arr.name in data) || !Array.isArray(data[arr.name])) continue;
    const airport = airportFrom(data[arr.name]);
    const itemFields = arr.children || [];
    data[arr.name] = records.map(r => {
      const row = {};
      for (const f of itemFields) {
        if (r[f.name] !== undefined) row[f.name] = r[f.name];
        else if (f.name === 'net_amount' || f.name === 'base_amount') row[f.name] = 0;
        else if (f.name === 'tax' || f.name === 'tax_rate' || f.name === 'line_total_aed' || f.name === 'line_total_usd' || f.name === 'quantity') row[f.name] = 0;
        else row[f.name] = null;
      }
      if (row.description == null) row.description = 'Landing Charge';
      if (row.charges_type == null) row.charges_type = row.description;
      if (row.airport == null) row.airport = airport;
      return row;
    });
  }
  return data;
}

function applyFilter(data, filterConfig) {
  if (!filterConfig || !data || typeof data !== 'object') return data;
  const { dropIf, keepIf } = filterConfig;
  const result = Array.isArray(data) ? [...data] : { ...data };
  if (Array.isArray(result)) return result;

  const wordList = v => Array.isArray(v) ? v.filter(w => typeof w === 'string' && w !== '').map(w => w.toLowerCase()) : null;
  const norm = s => String(s ?? '').toLowerCase().replace(/[-\u2013\u2014_]+/g, ' ');
  // Match against every text-like field an item may use for its label, so the
  // filter works for any array schema (e.g. summary_of_charges uses
  // "charge_subject", flight_details uses "description"/"charges_type").
  const itemText = item => {
    if (!item || typeof item !== 'object') return '';
    const fields = ['description', 'charges_type', 'charge_type', 'charge_subject', 'subject', 'service', 'services', 'title'];
    return fields.map(f => norm(item[f])).filter(Boolean).join(' ');
  };
  const hit = (text, w) => {
    const nw = norm(w);
    if (text.includes(nw)) return true;
    // Multi-word keywords (e.g. "handling charges", "passenger handling") are
    // matched on any individual word too, so they also catch variations like
    // "Handling Company's platform" or "Passenger Service Charge".
    return nw.split(/\s+/).filter(Boolean).some(word => word.length >= 3 && text.includes(word));
  };
  const dropWords = wordList(dropIf);
  const keepWords = wordList(keepIf);

  for (const [key, value] of Object.entries(result)) {
    if (!Array.isArray(value)) continue;
    let rows = value;

    if (dropWords || keepWords) {
      rows = rows.filter(item => {
        const t = itemText(item);
        if (dropWords && dropWords.some(w => hit(t, w))) return false;
        if (keepWords && keepWords.length && !keepWords.some(w => hit(t, w))) return false;
        return true;
      });
      result[key] = rows;
      continue;
    }

    if (dropIf && dropIf[key]) {
      const conditions = dropIf[key];
      rows = rows.filter(item => {
        for (const [field, pattern] of Object.entries(conditions)) {
          const val = item[field];
          if (Array.isArray(pattern)) {
            if (pattern.some(w => typeof w === 'string' && w !== '' && norm(val).includes(norm(w)))) return false;
          } else if (typeof pattern === 'string' && pattern !== '') {
            if (new RegExp(pattern, 'i').test(String(val ?? ''))) return false;
          } else if (pattern === '' || pattern === null) {
            if (val === undefined || val === null || val === '') return false;
          } else if (typeof val === 'number' || typeof val === 'string') {
            if (val === pattern) return false;
          }
        }
        return true;
      });
    }

    if (keepIf && keepIf[key]) {
      const conditions = keepIf[key];
      rows = rows.filter(item => {
        for (const [field, required] of Object.entries(conditions)) {
          if (required) {
            const val = item[field];
            if (Array.isArray(required)) {
              if (!required.some(w => typeof w === 'string' && w !== '' && norm(val).includes(norm(w)))) return false;
            } else if (typeof required === 'string') {
              if (!new RegExp(required, 'i').test(String(val ?? ''))) return false;
            } else if (val === undefined || val === null || val === '') {
              return false;
            }
          }
        }
        return true;
      });
    }

    result[key] = rows;
  }

  return result;
}

function arraySchemaOnly(schema) {
  if (!Array.isArray(schema)) return schema;
  return schema.filter(f => f.type === 'array');
}

async function extractPage(markdown, zodSchema, model, stats, prompt = getAiConfig().basePrompt, extraPrompt) {
  const extractor = getExtractor(model);
  const start = Date.now();
  const finalPrompt = extraPrompt ? `${prompt}\n\n${extraPrompt}` : prompt;
  const result = await extractor({ markdown, zodSchema, prompt: finalPrompt, model, repairJson: true, maxOutputTokens: 131072 });
  const data = result?.data !== undefined ? result.data : result;
  const usage = result?.usage || {};
  stats.time += Date.now() - start;
  stats.inputTokens += usage.inputTokens || 0;
  stats.outputTokens += usage.outputTokens || 0;
  stats.calls = (stats.calls || 0) + 1;
  return { data, usage };
}

async function runExtraction(coreResult, schemaUsed, model, opts = {}) {
  const pages = coreResult.pages;
  const fullZod = convertToZodSchema(schemaUsed);
  const arraySchema = arraySchemaOnly(schemaUsed);
  const protectArrays = (pages.length > 20 || opts.perPage) && arraySchema.length > 0;
  const stats = { time: 0, inputTokens: 0, outputTokens: 0 };
  const markdown = pages.map(p => p.content).join('\n\n');
  const datePaths = opts.dateFormat ? dateFieldPaths(schemaUsed) : [];
  const inputHint = opts.dateInputFormat ? (/^DD/i.test(opts.dateInputFormat) ? 'DD' : /^MM/i.test(opts.dateInputFormat) ? 'MM' : /^YYYY/i.test(opts.dateInputFormat) ? 'YYYY' : '') : '';
  for (const p of datePaths) { if (p.hint) continue; if (inputHint) p.hint = inputHint; }
  const inputNote = opts.dateInputFormat ? ` The SOURCE document writes dates as "${opts.dateInputFormat}" (for example, with source format "DD.MM.YYYY", the value "01.07.2026" means 1 July 2026, and "13.07.2026" means 13 July 2026). When reading source dates, always respect this order.` : '';
  const dateNote = opts.dateFormat ? `DATE FORMAT: Write every date value in the output (${(datePaths.map(p => (p.path || p).join('.')).join(', ')) || 'all date fields'}) as YYYY-MM-DD, in unambiguous ISO order — first the 4-digit year, then the 2-digit month, then the 2-digit day (for example, 1 July 2026 is "2026-07-01", and 13 July 2026 is "2026-07-13"). First read the source date in its documented order, then convert it to YYYY-MM-DD. Apply this to every date value, including dates inside array items, without exception.${inputNote}` : null;
  const ai = getAiConfig();
  const domainCfg = (opts.domain && ai.domains?.[opts.domain]) || null;
  const chargeAliases = domainCfg?.chargeTypeAliases || null;
  const movementPattern = domainCfg?.movementPattern || {};
  const basePrompt = [ai.basePrompt, domainCfg?.prompt || ''].filter(Boolean).join('\n\n');
  const finish = async (data, coverageInfo = {}) => {
    const { skipGlobal = false, preAdjusted = false, gap = null } = coverageInfo;
    let out = data;
    let reconciled = false;
    let coverageAdjusted = preAdjusted;
    let coverageGap = gap;
    const rowsOf = d => arraySchema.reduce((s, a) => s + (Array.isArray(d?.[a.name]) ? d[a.name].length : 0), 0);
    const arrLog = d => arraySchema.map(a => `${a.name}=${Array.isArray(d?.[a.name]) ? d[a.name].length : '?'}`).join(' ');
    console.info(`[finish] pre verifyTotals: ${arrLog(out)}`);
    if (opts.verifyTotals !== false) {
      const totalCheck = await verifyTotals(markdown, out, schemaUsed, model, stats, fullZod, extractPage, 2, { protectArrays });
      out = totalCheck.data;
      reconciled = totalCheck.reconciled;
    }
    console.info(`[finish] post verifyTotals (reconciled=${reconciled}): ${arrLog(out)}`);
    if (opts.verifyCoverage && !skipGlobal) {
      const coverageCheck = await verifyCoverage(markdown, out, schemaUsed, model, stats, fullZod, extractPage);
      out = coverageCheck.data;
      coverageAdjusted = coverageCheck.adjusted;
      coverageGap = coverageCheck.gap;
    }
    if (datePaths.length) out = applyDateFormats(out, datePaths, opts.dateFormat);
    const mdStructure = coreResult.pymupdfMarkdown || markdown;
    if (opts.dateInputFormat && datePaths.length) out = fixDatesFromSource(mdStructure, out, datePaths, opts.dateInputFormat, opts.dateFormat);
    out = canonicalizeMovements(out, mdStructure);
    console.info(`[finish] post canonicalizeMovements: ${arrLog(out)}`);
    out = reconcileMovementRows(mdStructure, out, arraySchema, opts.dateInputFormat, opts.dateFormat, movementPattern, chargeAliases, ai.domains?.[opts.domain]?.fieldVocabulary);
    console.info(`[finish] post reconcileMovementRows: ${arrLog(out)}`);
    out = normalizeChargeTypes(out, chargeAliases);
    return { data: out, reconciled, coverageAdjusted, coverageGap, usage: { inputTokens: stats.inputTokens, outputTokens: stats.outputTokens, calls: stats.calls || 0 }, time: stats.time };
  };

  if (pages.length <= 20 && !opts.perPage) {
    const totalRowsOf = data => arraySchema.reduce((s, a) => s + (Array.isArray(data?.[a.name]) ? data[a.name].length : 0), 0);
    const minRows = pages.length >= 6 ? 5 : 0;
    // Best-of-2: the extraction LLM is nondeterministic and can occasionally
    // under-extract (e.g. 11 rows instead of 77). Run twice when there are
    // array fields and keep whichever attempt recovered the most rows.
    const attempts = arraySchema.length > 0 ? 2 : 1;
    let best = null;
    let bestRows = -1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const { data } = await extractPage(markdown, fullZod, model, stats, basePrompt, dateNote || undefined);
        const totalRows = totalRowsOf(data);
        console.info(`[extraction] single-call attempt ${attempt + 1} produced ${totalRows} array rows.`);
        if (totalRows > bestRows) { best = data; bestRows = totalRows; }
        if (minRows === 0 || bestRows >= minRows) break;
      } catch (e) {
        if (!(e instanceof SyntaxError) || !e.message.includes('JSON')) throw e;
      }
    }
    if (best) {
      if (minRows === 0 || bestRows >= minRows) return await finish(best);
      console.info(`[extraction] best single-call produced ${bestRows} array rows (min ${minRows}) — falling back to per-page.`);
    } else {
      console.info('[extraction] single-call extraction failed — falling back to per-page.');
    }
  }

  if (!arraySchema.length) {
    const { data } = await extractPage(markdown, fullZod, model, stats, basePrompt, dateNote || undefined);
    return await finish(data);
  }

  const arrayZod = convertToZodSchema(arraySchema);
  const concurrency = Math.min(8, pages.length);
  const limit = pLimit(concurrency);

  const page1Full = await extractPage(pages[0].content, fullZod, model, stats, basePrompt, dateNote || undefined);

  const TAIL_LINES = 25;
  const MARKER = '===== CURRENT PAGE BELOW =====';
  const CONTINUATION_NOTE = `The text above the "${MARKER}" marker is the TAIL of the PREVIOUS page, provided as context only.
- Data rows FULLY above the marker belong to the PREVIOUS page — DO NOT extract them (they were already extracted from that page).
- Data rows FULLY below the marker belong to the CURRENT page — extract every one of them, without skipping any.
- If a single data row is SPLIT ACROSS the marker (some of its values appear above the marker, the rest below), it is ONE row that continues onto this page — RECONSTRUCT it as one complete row with every visible value. Do not skip it, do not duplicate it, and do not leave visible values empty.`;
  const PAGE_NOTE = [CONTINUATION_NOTE, dateNote].filter(Boolean).join('\n\n');

  const inputs = pages.map((p, i) => {
    if (i === 0) return p.content;
    const prevTail = pages[i - 1].content.split('\n').slice(-TAIL_LINES).join('\n');
    return `${prevTail}\n\n${MARKER}\n\n${p.content}`;
  });

  const extractAllPages = () => Promise.all(
    inputs.map(input => limit(() => extractPage(input, arrayZod, model, stats, basePrompt, PAGE_NOTE)))
  );

  const arrayResults = await extractAllPages();

  const mergeArrays = () => {
    const out = { ...page1Full.data };
    for (const field of arraySchema) {
      const name = field.name;
      out[name] = dedupeRowsAcrossPages(arrayResults.map(r => r.data?.[name] || []));
    }
    return out;
  };
  const arrayGap = (mergedData, expected) => {
    const gap = {};
    for (const a of arraySchema) {
      const actual = Array.isArray(mergedData[a.name]) ? mergedData[a.name].length : 0;
      const e = expected?.[a.name];
      if (typeof e === 'number' && actual !== e) {
        gap[a.name] = { expected: e, actual };
        console.info(`[verifyCoverage] GAP array=${a.name} merged=${actual} expected=${e}`);
      }
    }
    return gap;
  };
  const gapTotal = g => Object.values(g || {}).reduce((s, v) => s + Math.abs(v.expected - v.actual), 0);

  let merged = mergeArrays();
  let coverageInfo = { skipGlobal: true, preAdjusted: false, gap: null };

  if (opts.verifyCoverage) {
    const pageCheck = await verifyCoveragePerPage(inputs, arrayResults, arraySchema, model, stats, arrayZod, extractPage);
    coverageInfo.preAdjusted = pageCheck.adjusted;

    const expected = {};
    const incomplete = [];
    const pageCounts = pageCheck.pageCounts || {};
    for (const a of arraySchema) {
      let sum = 0;
      let complete = true;
      for (let i = 0; i < inputs.length; i++) {
        const n = pageCounts[i]?.[a.name];
        if (typeof n !== 'number') { complete = false; break; }
        sum += n;
      }
      if (complete) expected[a.name] = sum;
      else incomplete.push(a.name);
    }
    if (incomplete.length) {
      const fallback = await countRows(markdown, arraySchema, model, stats, extractPage);
      console.info(`[verifyCoverage] fallback global count (per-page counts incomplete for ${incomplete.join(',')}): ${JSON.stringify(fallback)}`);
      for (const name of incomplete) {
        if (typeof fallback?.[name] === 'number') expected[name] = fallback[name];
      }
    }
    console.info(`[verifyCoverage] expected counts (sum of per-page counts): ${JSON.stringify(expected)}`);
    let gap = arrayGap(merged, expected);
    if (gapTotal(gap) > 0 && gapTotal(gap) <= 5) {
      console.info('[verifyCoverage] small gap detected — re-extracting all pages once to close it.');
      const retried = await extractAllPages();
      for (let i = 0; i < inputs.length; i++) arrayResults[i] = retried[i];
      const remerged = mergeArrays();
      const gap2 = arrayGap(remerged, expected);
      if (gapTotal(gap2) < gapTotal(gap)) {
        merged = remerged;
        gap = gap2;
        coverageInfo.preAdjusted = true;
        console.info('[verifyCoverage] retry improved coverage; keeping the better result.');
      } else {
        console.info('[verifyCoverage] retry did not improve coverage; keeping the original result.');
      }
    }
    coverageInfo.gap = gapTotal(gap) > 0 ? gap : null;
  }

  return await finish(merged, coverageInfo);
}

const ID_KEY_RE = /flight|registr|reg\b|date|number|_no$|_id$|reference|ref$|serial|invoice|code$/i;

function rowKey(r) {
  const keys = Object.keys(r).filter(k => ID_KEY_RE.test(k));
  if (!keys.length) return null;
  return keys.sort().map(k => String(r[k] ?? '')).join('|');
}

function mergeRowSubset(a, b) {
  const values = o => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined && v !== ''));
  const av = values(a), bv = values(b);
  const isSubsetOf = (small, big) => Object.keys(small).length > 0 && Object.keys(small).every(k => k in big && String(small[k]).trim() === String(big[k]).trim());
  if (isSubsetOf(av, bv)) return b;
  if (isSubsetOf(bv, av)) return a;
  return null;
}

function dedupeRowsAcrossPages(pageArrays) {
  const out = [];
  const recent = [];
  const DEDUPE_WINDOW = 50;
  for (const rows of pageArrays || []) {
    for (const r of rows || []) {
      if (!r || typeof r !== 'object') { out.push(r); continue; }
      const exact = JSON.stringify(Object.entries(r).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
      const idKey = rowKey(r);
      const exactIdx = recent.findIndex(e => e.exact === exact);
      if (exactIdx !== -1) continue;
      let keyIdx = -1;
      if (idKey) keyIdx = recent.findIndex(e => e.idKey === idKey);
      if (keyIdx !== -1) {
        const merged = mergeRowSubset(recent[keyIdx].r, r);
        if (merged) {
          out[recent[keyIdx].outIdx] = merged;
          recent[keyIdx].r = merged;
          continue;
        }
      }
      const entry = { exact, idKey, r, outIdx: out.length };
      recent.push(entry);
      out.push(r);
      if (recent.length > DEDUPE_WINDOW) recent.shift();
    }
  }
  return out;
}

function renderPage(templateNames) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Documind Test</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#f5f5f5;padding:2rem;color:#333}
.container{max-width:900px;margin:0 auto}
h1{font-size:1.5rem;margin-bottom:.5rem}
.card{background:#fff;border-radius:8px;padding:1.5rem;box-shadow:0 1px 3px rgba(0,0,0,.1);margin-bottom:1rem}
label{display:block;font-weight:600;margin-bottom:.4rem;font-size:.9rem}
input,select{width:100%;padding:.5rem;border:1px solid #ccc;border-radius:4px;font-size:.9rem}
button{background:#2563eb;color:#fff;border:none;padding:.6rem 1.2rem;border-radius:4px;font-size:.9rem;cursor:pointer}
button:hover{background:#1d4ed8}
button:disabled{background:#93c5fd;cursor:not-allowed}
#result{margin-top:1rem;white-space:pre-wrap;font-family:ui-monospace,monospace;font-size:.8rem;line-height:1.4;max-height:600px;overflow:auto;background:#1e1e2e;color:#cdd6f4;padding:1rem;border-radius:6px;display:none}
.status-bar{display:none;margin-top:.5rem;padding:.4rem .8rem;border-radius:4px;font-size:.85rem}
.status-processing{background:#dbeafe;color:#1e40af}
.status-done{background:#dcfce7;color:#166534}
.status-error{background:#fee2e2;color:#991b1b}
.form-row{display:flex;gap:1rem;align-items:end;flex-wrap:wrap}
.form-row>div{flex:1;min-width:200px}
.form-row button{height:fit-content;padding:.5rem 1.5rem}
</style>
</head>
<body>
<div class="container">
<h1>Documind &mdash; Document Extraction</h1>
<p>Upload a document to extract structured data using AI. Large files may take a minute or two.</p>
<div class="card">
<form id="uploadForm" enctype="multipart/form-data">
<div class="form-row">
<div>
<label for="file">Document</label>
<input type="file" id="file" name="file" required accept=".pdf,.png,.jpg,.jpeg,.txt,.docx,.html">
</div>
<div>
<label for="template">Template</label>
<select id="template" name="template">
<option value="">None (raw markdown)</option>
<option value="__custom__">Custom schema (paste below)</option>
${templateNames.map(t => `<option value="${t}">${t.replace(/_/g, ' ')}</option>`).join('')}
</select>
</div>
</div>
<div style="margin-top:.8rem">
<label for="schema">Custom Schema (JSON)</label>
<textarea id="schema" name="schema" rows="6" style="width:100%;font-family:ui-monospace,monospace;font-size:.8rem;padding:.5rem;border:1px solid #ccc;border-radius:4px;resize:vertical" placeholder='[{"name":"fieldName","type":"string","description":"Field description"}]'></textarea>
</div>
<div style="margin-top:.5rem">
<label for="filter">Filter Rules (JSON, optional)</label>
<textarea id="filter" name="filter" rows="3" style="width:100%;font-family:ui-monospace,monospace;font-size:.78rem;padding:.5rem;border:1px solid #ccc;border-radius:4px;resize:vertical" placeholder='{"dropIf":{"transactions":{"description":"^Account Credit"}},"keepIf":{"transactions":{"date":true}}}'></textarea>
</div>
<button type="submit" id="submitBtn" style="margin-top:.8rem">Extract</button>
</form>
<div id="statusBar" class="status-bar"></div>
<pre id="result"></pre>
</div>
</div>
<script>
const form = document.getElementById('uploadForm');
const submitBtn = document.getElementById('submitBtn');
const result = document.getElementById('result');
const statusBar = document.getElementById('statusBar');
const templateSelect = document.getElementById('template');
const schemaArea = document.getElementById('schema');

templateSelect.addEventListener('change', () => {
  schemaArea.disabled = templateSelect.value !== '__custom__';
  if (templateSelect.value !== '__custom__') schemaArea.value = '';
});
schemaArea.addEventListener('input', () => {
  if (schemaArea.value.trim()) {
    templateSelect.value = '__custom__';
    schemaArea.disabled = false;
  }
});
schemaArea.disabled = true;

form.onsubmit = async (e) => {
  e.preventDefault();
  const fd = new FormData();
  fd.append('file', document.getElementById('file').files[0]);
  fd.append('template', document.getElementById('template').value);
  fd.append('schema', document.getElementById('schema').value);
  fd.append('filter', document.getElementById('filter').value);
  submitBtn.disabled = true;
  result.style.display = 'none';
  statusBar.style.display = 'block';
  statusBar.className = 'status-bar status-processing';
  statusBar.textContent = 'Submitting...';

  try {
    const r = await fetch('/extract', { method: 'POST', body: fd });
    const job = await r.json();
    if (job.error) { showError(job.error); return; }

    const jobId = job.jobId;
    statusBar.textContent = 'Processing document... (this may take a while for large files)';

    const poll = setInterval(async () => {
      try {
        const res = await fetch('/result/' + jobId);
        const d = await res.json();
        if (d.status === 'error') {
          clearInterval(poll);
          showError(d.meta?.error || 'Extraction failed');
        } else if (d.status === 'done') {
          clearInterval(poll);
          const m = d.meta || {};
          const t = m.timing || {};
          const tk = m.tokens || {};
          const c = m.cost || {};
          statusBar.className = 'status-bar status-done';
          statusBar.innerHTML = 'Fetching data...';
          submitBtn.disabled = false;
          try {
            const dr = await fetch('/data/' + jobId);
            const data = await dr.json();
            statusBar.innerHTML = 'Done! ' + (m.pages||'') + ' pages &mdash; ' +
              (t.total ? (t.total/1000).toFixed(1) + 's' : '') +
              (c.total ? ' | ' + (tk.total?.input||0).toLocaleString() + ' in / ' + (tk.total?.output||0).toLocaleString() + ' out tokens' : '') +
              (c.total ? ' | $' + c.total : '');
            const display = data.data || data.markdown || data;
            result.textContent = JSON.stringify(display, null, 2);
            result.style.display = 'block';
          } catch (err) {
            showError('Failed to load data: ' + err.message);
          }
        }
      } catch (err) {
        clearInterval(poll);
        showError('Polling failed: ' + err.message);
      }
    }, 2000);
  } catch (err) {
    showError('Submit failed: ' + err.message);
  }
};

function showError(msg) {
  statusBar.className = 'status-bar status-error';
  statusBar.textContent = 'Error: ' + msg;
  submitBtn.disabled = false;
}
</script>
</body>
</html>`;
}

const tpls = templates.list();
const model = process.env.MODEL || 'gemini-2.5-flash';

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/api/docs') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Documind API Documentation</title>
<link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css">
<style>html{box-sizing:border-box;overflow:-moz-scrollbars-vertical;overflow-y:scroll}*,:after,:before{box-sizing:inherit}body{margin:0;background:#fafafa}.swagger-ui .topbar{display:none}</style>
</head>
<body>
<div id="swagger-ui"></div>
<script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js" crossorigin></script>
<script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-standalone-preset.js" crossorigin></script>
<script>SwaggerUIBundle({url:'/api/docs/openapi.json',dom_id:'#swagger-ui',presets:[SwaggerUIBundle.presets.apis,SwaggerUIStandalonePreset],layout:'StandaloneLayout'})</script>
</body>
</html>`);
    return;
  }

  if (url.pathname === '/api/docs/openapi.json') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(readFileSync(join(__dirname, 'openapi.json'), 'utf-8'));
    return;
  }

  if (url.pathname === '/favicon.ico' || url.pathname === '/favicon.png') {
    const icon = url.pathname.endsWith('.png') ? 'favicon.png' : 'favicon.ico';
    res.writeHead(200, { 'Content-Type': url.pathname.endsWith('.png') ? 'image/png' : 'image/x-icon' });
    res.end(readFileSync(join(__dirname, icon)));
    return;
  }

  if (url.pathname === '/login') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(readFileSync(join(__dirname, 'login.html'), 'utf-8'));
    return;
  }

  function servePage(pageFile, title, activePage) {
    const layout = readFileSync(join(__dirname, 'layout.html'), 'utf-8');
    const content = readFileSync(join(__dirname, 'pages', pageFile), 'utf-8');
    const html = layout
      .replace('{{TITLE}}', title)
      .split('{{CONTENT}}').join(content)
      .replace('{{HOME_ACTIVE}}', activePage === 'home' ? 'active' : '')
      .replace('{{TASKS_ACTIVE}}', activePage === 'tasks' ? 'active' : '')
      .replace('{{KEYS_ACTIVE}}', activePage === 'keys' ? 'active' : '')
      .replace('{{REFERENCE_ACTIVE}}', activePage === 'reference' ? 'active' : '')
      .replace('{{DEV_ACTIVE}}', (activePage === 'keys' || activePage === 'reference') ? 'active' : '')
      .replace('{{DEV_OPEN}}', (activePage === 'keys' || activePage === 'reference') ? 'block' : 'none')
      .replace('{{SCHEMAS_ACTIVE}}', activePage === 'schemas' ? 'active' : '')
      .replace('{{SETTINGS_ACTIVE}}', activePage === 'settings' ? 'active' : '');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  }

  if (url.pathname === '/' || url.pathname === '/index.html') {
    return servePage('home.html', 'Dashboard', 'home');
  }

  if (url.pathname === '/tasks') {
    return servePage('tasks.html', 'Tasks', 'tasks');
  }

  if (url.pathname.startsWith('/tasks/')) {
    const jobId = url.pathname.split('/')[2];
    if (jobId) return servePage('task-details.html', 'Task Details', 'tasks');
  }

  if (url.pathname === '/keys') {
    return servePage('keys.html', 'API Keys', 'keys');
  }

  if (url.pathname === '/reference') {
    const base = process.env.BASE_URL || `http://localhost:${PORT}`;
    const layout = readFileSync(join(__dirname, 'layout.html'), 'utf-8');
    let content = readFileSync(join(__dirname, 'pages', 'reference.html'), 'utf-8');
    content = content.replace(/\{\{BASE_URL\}\}/g, base);
    content = content.replace('id="refBaseUrl"', `id="refBaseUrl">${base}`);
    const html = layout
      .replace('{{TITLE}}', 'API Reference')
      .split('{{CONTENT}}').join(content)
      .replace('{{HOME_ACTIVE}}', '')
      .replace('{{TASKS_ACTIVE}}', '')
      .replace('{{KEYS_ACTIVE}}', '')
      .replace('{{REFERENCE_ACTIVE}}', 'active')
      .replace('{{DEV_ACTIVE}}', 'active')
      .replace('{{DEV_OPEN}}', 'block')
      .replace('{{SCHEMAS_ACTIVE}}', '')
      .replace('{{SETTINGS_ACTIVE}}', '');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  if (url.pathname === '/schemas') {
    return servePage('schemas.html', 'Schema Generator', 'schemas');
  }

  if (url.pathname === '/settings') {
    return servePage('settings.html', 'Settings', 'settings');
  }

  if (url.pathname === '/api/stats' && req.method === 'GET') {
    const user = await authGuard(req, res);
    if (!user) return;
    return sendJSON(res, 200, await getStats(user.id, user.role === 1));
  }

  if (url.pathname === '/api/stats/templates' && req.method === 'GET') {
    const user = await authGuard(req, res);
    if (!user) return;
    const jobs = (await getJobs(user.id, user.role === 1)).filter(j => j.status === 'done');
    const tpls = await getTemplates();
    const tplById = Object.fromEntries(tpls.map(t => [t.id, t.name]));

    const agg = {};
    jobs.forEach(j => {
      let label;
      if (j.templateName && tplById[j.templateName]) {
        label = tplById[j.templateName];
      } else if (j.templateName) {
        label = j.templateName;
      } else if (j.schema) {
        label = 'Custom Schema';
      } else {
        label = 'Raw Markdown';
      }
      agg[label] = agg[label] || { count: 0, cost: 0 };
      agg[label].count += 1;
      agg[label].cost += j.cost?.total || 0;
    });
    return sendJSON(res, 200, Object.entries(agg).map(([name, v]) => ({ name, count: v.count, cost: v.cost })));
  }

  if (url.pathname === '/api/tasks' && req.method === 'GET') {
    const user = await authGuard(req, res);
    if (!user) return;
    const limit = parseInt(url.searchParams.get('limit')) || 0;
    const offset = parseInt(url.searchParams.get('offset')) || 0;
    const filter = {
      schema: url.searchParams.get('tab') || undefined,
      q: url.searchParams.get('q')?.trim() || undefined,
      status: url.searchParams.get('status') || undefined,
      tpl: url.searchParams.get('tpl')?.split(',').map(v => v.trim()).filter(Boolean),
      from: url.searchParams.get('from') || undefined,
      to: url.searchParams.get('to') || undefined,
    };
    if (filter.schema !== 'schema' && filter.schema !== 'extraction') filter.schema = undefined;
    const withUsers = jobs => jobs.map(j => ({ ...j, userName: j.userName || 'System' }));
    if (limit > 0) {
      const [jobs, counts] = await Promise.all([getJobCards(user.id, user.role === 1, limit, offset, filter), getJobCounts(user.id, user.role === 1, filter)]);
      return sendJSON(res, 200, { jobs: withUsers(jobs), total: counts.total, schemaCount: counts.schemaGen, hasMore: offset + jobs.length < counts.filteredTotal });
    }
    const jobs = await getJobCards(user.id, user.role === 1, 0, 0, filter);
    return sendJSON(res, 200, withUsers(jobs));
  }

  if (url.pathname.match(/^\/api\/tasks\/[^/]+\/file$/) && req.method === 'GET') {
    const headerAuth = await (async () => {
      const h = req.headers['authorization'] || '';
      if (h.startsWith('Bearer ')) { try { return verifyToken(h.slice(7)); } catch {} }
      const apiKey = req.headers['x-api-key'];
      if (apiKey) { try { return await getApiKeyUser(apiKey); } catch {} }
      return null;
    })();
    const user = headerAuth || authFromQuery(url, res);
    if (!user) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
    const jobId = url.pathname.split('/')[3];
    const job = (await getJobs(user.id, user.role === 1)).find(j => j.id === jobId);
    if (!job) return sendJSON(res, 404, { error: 'Task not found' });
    const stored = job.storedFiles || [];
    const requested = url.searchParams.get('name');
    let entry = stored.find(f => f.name === requested);
    if (!entry) {
      if (requested) return sendJSON(res, 404, { error: 'File not found' });
      entry = stored.find(f => f.ext === 'pdf') || stored[0];
    }
    if (!entry) return sendJSON(res, 404, { error: 'No file stored for this task' });
    const connector = entry.storageId ? await getStorageConnector(entry.storageId) : null;
    const opened = await openJobFile(jobId, entry, connector);
    if (!opened) return sendJSON(res, 404, { error: 'File not found' });
    res.writeHead(200, {
      'Content-Type': MIME[entry.ext] || 'application/octet-stream',
      'Content-Length': opened.size,
      'Content-Disposition': `inline; filename="${entry.name.replace(/"/g, '')}"`,
      'Cache-Control': 'private, max-age=3600',
    });
    opened.stream.pipe(res);
    return;
  }

  if (url.pathname.startsWith('/api/tasks/') && req.method === 'GET') {
    const user = await authGuard(req, res);
    if (!user) return;
    const parts = url.pathname.split('/');
    const last = parts[parts.length - 1];
    const isData = last === 'data';
    const isCsv = last === 'csv';
    const taskId = parts[parts.length - (isData || isCsv ? 2 : 1)];
    const job = (await getJobs(user.id, user.role === 1)).find(j => j.id === taskId);
    if (!job) return sendJSON(res, 404, { error: 'Task not found' });
    if (isData || isCsv) {
      let resultObj = null;
      const memJob = jobs.get(taskId);
      if (memJob && memJob.data) resultObj = memJob.data;
      const resultData = job.resultData ?? (await getJobResultData(taskId));
      if (!resultObj && resultData) {
        try { resultObj = JSON.parse(resultData); } catch {}
      }
      if (!resultObj) resultObj = job.data || {};
      if (isData) return sendJSON(res, 200, resultObj);
      const { fileName, charges, details, rowCount } = buildCsvExport(resultObj, job.fileName);
      return sendJSON(res, 200, { fileName: fileName || job.fileName || null, charges, details, rowCount });
    }
    return sendJSON(res, 200, job);
  }

  if (url.pathname.startsWith('/api/tasks/') && req.method === 'DELETE') {
    const user = await authGuard(req, res);
    if (!user) return;
    const taskId = url.pathname.split('/').pop();
    if (!taskId) return sendJSON(res, 400, { error: 'Missing task id' });
    const job = (await getJobs(user.id, user.role === 1)).find(j => j.id === taskId);
    if (!job) return sendJSON(res, 404, { error: 'Task not found' });
    jobs.delete(taskId);
    schemaJobs.delete(taskId);
    await deleteJobFiles(taskId, job.storedFiles).catch(() => {});
    const removed = await deleteJob(taskId);
    if (!removed) return sendJSON(res, 404, { error: 'Task not found' });
    return sendJSON(res, 200, { success: true });
  }

  if (url.pathname.startsWith('/api/tasks/') && req.method === 'POST') {
    const rerunMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/rerun$/);
    if (!rerunMatch) return sendJSON(res, 404, { error: 'Not found' });
    const user = await authGuard(req, res);
    if (!user) return;
    const taskId = rerunMatch[1];
    const job = (await getJobs(user.id, user.role === 1)).find(j => j.id === taskId);
    if (!job) return sendJSON(res, 404, { error: 'Task not found' });
    if (job.templateName === 'schema-generation') return sendJSON(res, 400, { error: 'Schema generation tasks cannot be re-run' });
    if (!job.storedFiles || !job.storedFiles.length) return sendJSON(res, 400, { error: 'This task has no stored file to re-run' });
    const connector = job.storedFiles[0].storageId ? await getStorageConnector(job.storedFiles[0].storageId) : null;
    const opened = await openJobFile(taskId, job.storedFiles[0], connector);
    if (!opened) return sendJSON(res, 400, { error: 'The stored file could not be read for re-run' });
    const chunks = [];
    for await (const c of opened.stream) chunks.push(c);
    const data = Buffer.concat(chunks);

    const fields = {};
    let tplId = job.templateName || null;
    if (tplId) {
      const tpls = await getTemplates();
      if (!tpls.some(t => t.id === tplId || t.name === tplId)) tplId = null;
    }
    if (tplId) {
      // Template-based rerun: use the template's CURRENT schema, filter and domain
      // (parseSchema loads them from the template), not the job's stored snapshot.
      fields.template_id = tplId;
    } else {
      fields.filter = job.filter || '';
      if (job.schema) fields.schema = Array.isArray(job.schema) ? JSON.stringify(job.schema) : String(job.schema);
    }

    const model = process.env.MODEL || 'gemini-2.5-flash';
    const newJobId = crypto.randomBytes(8).toString('hex');
    const started = await startAsyncPipeline(newJobId, { data, filename: job.storedFiles[0].name }, fields, user, model);
    return sendJSON(res, 200, { jobId: newJobId, rerunOf: taskId, ...started });
  }

  if (url.pathname === '/api/login' && req.method === 'POST') {
    const body = await new Promise((res, rej) => {
      const c = []; req.on('data', d => c.push(d)); req.on('end', () => res(Buffer.concat(c).toString())); req.on('error', rej);
    });
    try {
      const { email, password } = JSON.parse(body);
      const user = await getUserByEmail(email);
      if (!user || !(await comparePassword(password, user.password_hash))) {
        return sendJSON(res, 401, { error: 'Invalid email or password' });
      }
      const token = signToken(user);
      sendJSON(res, 200, { token, user: { id: user.id, email: user.email, role: user.role, company_id: user.company_id, company_name: user.company_name, first_name: user.first_name || null, last_name: user.last_name || null } });
    } catch (e) {
      sendJSON(res, 400, { error: e.message });
    }
    return;
  }

  if (url.pathname === '/api/me' && req.method === 'GET') {
    const user = await authGuard(req, res);
    if (!user) return;
    return sendJSON(res, 200, { id: user.id, email: user.email, role: user.role, company_id: user.company_id, company_name: user.company_name, first_name: user.first_name || null, last_name: user.last_name || null });
  }

  if (url.pathname === '/api/settings' && req.method === 'GET') {
    const authUser = await authGuard(req, res);
    if (!authUser || authUser.role !== 1) return sendJSON(res, 403, { error: 'Admin only' });
    const ai = getAiConfig();
    return sendJSON(res, 200, {
      model: process.env.MODEL || 'gemini-2.5-flash',
      basePrompt: ai.basePrompt,
      classifyPrompt: ai.classifyPrompt,
      domains: ai.domains,
    });
  }

  if (url.pathname === '/api/settings' && req.method === 'POST') {
    const authUser = await authGuard(req, res);
    if (!authUser || authUser.role !== 1) return sendJSON(res, 403, { error: 'Admin only' });
    const body = await new Promise((res, rej) => {
      const c = []; req.on('data', d => c.push(d)); req.on('end', () => res(Buffer.concat(c).toString())); req.on('error', rej);
    });
    try {
      const data = JSON.parse(body);
      if (data.model) {
        process.env.MODEL = data.model;
      }
      if (typeof data.basePrompt === 'string') await setSetting('ai.base_prompt', data.basePrompt);
      if (typeof data.classifyPrompt === 'string') await setSetting('ai.classify_prompt', data.classifyPrompt);
      if (data.domains && typeof data.domains === 'object') await setSetting('domains', data.domains);
      await loadAiConfig();
      sendJSON(res, 200, { success: true });
    } catch (e) {
      sendJSON(res, 400, { error: e.message });
    }
    return;
  }

  if (url.pathname === '/api/storage' && req.method === 'GET') {
    const authUser = await authGuard(req, res);
    if (!authUser || authUser.role !== 1) return sendJSON(res, 403, { error: 'Admin only' });
    const list = await getStorageConnectors();
    return sendJSON(res, 200, {
      activeId: list.activeId,
      connectors: list.connectors.map(c => ({
        id: c.id, name: c.name, type: c.type, status: c.status, active: c.active,
        s3: c.type === 's3' ? { endpoint: c.s3?.endpoint || '', region: c.s3?.region || '', bucket: c.s3?.bucket || '', prefix: c.s3?.prefix || '', hasSecret: !!(c.s3?.secretAccessKey) } : null,
      })),
    });
  }

  if (url.pathname === '/api/storage/test' && req.method === 'POST') {
    const authUser = await authGuard(req, res);
    if (!authUser || authUser.role !== 1) return sendJSON(res, 403, { error: 'Admin only' });
    const body = await new Promise((res, rej) => {
      const c = []; req.on('data', d => c.push(d)); req.on('end', () => res(Buffer.concat(c).toString())); req.on('error', rej);
    });
    try {
      const data = JSON.parse(body);
      if (data.type === 'local') return sendJSON(res, 200, { ok: true });
      const s = data.s3 || {};
      if (!s.bucket || !s.accessKeyId || !s.secretAccessKey) {
        return sendJSON(res, 400, { ok: false, error: 'S3 requires bucket, access key ID and secret access key' });
      }
      await testS3Connection({ provider: 's3', s3: {
        endpoint: (s.endpoint || '').trim(),
        region: (s.region || '').trim() || 'us-east-1',
        accessKeyId: (s.accessKeyId || '').trim(),
        secretAccessKey: s.secretAccessKey,
        bucket: (s.bucket || '').trim(),
        prefix: (s.prefix || '').trim(),
      } });
      return sendJSON(res, 200, { ok: true });
    } catch (e) {
      const code = e.Code || (e.name && e.name !== 'Unknown' ? e.name : '');
      const status = e.$metadata?.httpStatusCode ? `HTTP ${e.$metadata.httpStatusCode}` : '';
      const msg = [status, code, status && code ? '— check credentials and bucket access' : ''].filter(Boolean).join(' ');
      return sendJSON(res, 200, { ok: false, error: msg || (e.message || 'Connection failed') });
    }
  }

  if (url.pathname === '/api/storage' && req.method === 'POST') {
    const authUser = await authGuard(req, res);
    if (!authUser || authUser.role !== 1) return sendJSON(res, 403, { error: 'Admin only' });
    const body = await new Promise((res, rej) => {
      const c = []; req.on('data', d => c.push(d)); req.on('end', () => res(Buffer.concat(c).toString())); req.on('error', rej);
    });
    try {
      const data = JSON.parse(body);
      if (!data.name || !data.name.trim()) return sendJSON(res, 400, { error: 'Connection name is required' });
      const s = data.s3 || {};
      const conn = {
        id: crypto.randomBytes(8).toString('hex'),
        name: data.name.trim(),
        type: data.type === 's3' ? 's3' : 'local',
        status: 'connected',
        s3: data.type === 's3' ? {
          endpoint: (s.endpoint || '').trim(),
          region: (s.region || '').trim() || 'us-east-1',
          accessKeyId: (s.accessKeyId || '').trim(),
          secretAccessKey: s.secretAccessKey,
          bucket: (s.bucket || '').trim(),
          prefix: (s.prefix || '').trim(),
        } : {},
      };
      const list = await addStorageConnector(conn);
      return sendJSON(res, 200, { success: true, activeId: list.activeId });
    } catch (e) {
      return sendJSON(res, 400, { error: e.message });
    }
  }

  if (url.pathname === '/api/storage/active' && req.method === 'POST') {
    const authUser = await authGuard(req, res);
    if (!authUser || authUser.role !== 1) return sendJSON(res, 403, { error: 'Admin only' });
    const body = await new Promise((res, rej) => {
      const c = []; req.on('data', d => c.push(d)); req.on('end', () => res(Buffer.concat(c).toString())); req.on('error', rej);
    });
    try {
      const data = JSON.parse(body);
      const list = await setActiveStorageConnector(data.id);
      return sendJSON(res, 200, { success: true, activeId: list.activeId });
    } catch (e) {
      return sendJSON(res, 400, { error: e.message });
    }
  }

  if (url.pathname.startsWith('/api/storage/') && req.method === 'DELETE') {
    const authUser = await authGuard(req, res);
    if (!authUser || authUser.role !== 1) return sendJSON(res, 403, { error: 'Admin only' });
    const id = url.pathname.split('/')[3];
    if (!id) return sendJSON(res, 400, { error: 'Missing connector id' });
    const list = await deleteStorageConnector(id);
    return sendJSON(res, 200, { success: true, activeId: list.activeId });
  }

  if (url.pathname === '/api/users' && req.method === 'GET') {
    const authUser = await authGuard(req, res);
    if (!authUser || authUser.role !== 1) return sendJSON(res, 403, { error: 'Admin only' });
    return sendJSON(res, 200, await getUsers());
  }
  if (url.pathname === '/api/users' && req.method === 'POST') {
    const authUser = await authGuard(req, res);
    if (!authUser || authUser.role !== 1) return sendJSON(res, 403, { error: 'Admin only' });
    const body = await new Promise((res, rej) => { const c = []; req.on('data', d => c.push(d)); req.on('end', () => res(Buffer.concat(c).toString())); req.on('error', rej); });
    try {
      const { email, password, role, company_id, first_name, last_name } = JSON.parse(body);
      const company = (await getCompanies()).find(c => c.id === company_id);
      const hash = await hashPassword(password);
      const u = await addUser({ email, password_hash: hash, role: role || 2, first_name: first_name || null, last_name: last_name || null, company_id: company_id || null, company_name: company?.name || '' });
      if (!u) return sendJSON(res, 400, { error: 'Email already exists' });
      sendJSON(res, 200, { id: u.id, email: u.email, role: u.role, first_name: u.first_name, last_name: u.last_name, company_id: u.company_id, company_name: u.company_name });
    } catch (e) { sendJSON(res, 400, { error: e.message }); }
    return;
  }
  if (url.pathname.startsWith('/api/users/') && (req.method === 'PUT' || req.method === 'DELETE')) {
    const authUser = await authGuard(req, res);
    if (!authUser || authUser.role !== 1) return sendJSON(res, 403, { error: 'Admin only' });
    const id = url.pathname.split('/').pop();
    if (req.method === 'DELETE') { const ok = await deleteUser(id); return sendJSON(res, ok ? 200 : 404, ok ? { success: true } : { error: 'Not found' }); }
    const body = await new Promise((res, rej) => { const c = []; req.on('data', d => c.push(d)); req.on('end', () => res(Buffer.concat(c).toString())); req.on('error', rej); });
    try {
      const data = JSON.parse(body); const updates = {};
      if (data.email) updates.email = data.email;
      if (data.role) updates.role = data.role;
      if (data.first_name !== undefined) updates.first_name = data.first_name;
      if (data.last_name !== undefined) updates.last_name = data.last_name;
      if (data.password) updates.password_hash = await hashPassword(data.password);
      if (data.company_id !== undefined) { updates.company_id = data.company_id || null; const company = (await getCompanies()).find(c => c.id === data.company_id); updates.company_name = company?.name || ''; }
      const u = await updateUser(id, updates);
      sendJSON(res, u ? 200 : 404, u ? { id: u.id, email: u.email, role: u.role, first_name: u.first_name, last_name: u.last_name, company_id: u.company_id, company_name: u.company_name } : { error: 'Not found' });
    } catch (e) { sendJSON(res, 400, { error: e.message }); }
    return;
  }

  if (url.pathname === '/api/keys' && req.method === 'GET') {
    const user = await authGuard(req, res);
    if (!user) return;
    return sendJSON(res, 200, await getUserApiKeys(user.id));
  }

  if (url.pathname === '/api/keys' && req.method === 'POST') {
    const user = await authGuard(req, res);
    if (!user) return;
    const body = await new Promise((res, rej) => { const c = []; req.on('data', d => c.push(d)); req.on('end', () => res(Buffer.concat(c).toString())); req.on('error', rej); });
    try {
      const { name } = JSON.parse(body);
      const k = await createApiKey(user.id, name);
      sendJSON(res, 200, k);
    } catch (e) { sendJSON(res, 400, { error: e.message }); }
    return;
  }

  if (url.pathname.startsWith('/api/keys/') && req.method === 'DELETE') {
    const user = await authGuard(req, res);
    if (!user) return;
    const id = url.pathname.split('/').pop();
    const ok = await revokeApiKey(id, user.id);
    sendJSON(res, ok ? 200 : 404, ok ? { success: true } : { error: 'Not found' });
    return;
  }

  if (url.pathname === '/api/companies' && req.method === 'GET') {
    const authUser = await authGuard(req, res);
    if (!authUser || authUser.role !== 1) return sendJSON(res, 403, { error: 'Admin only' });
    return sendJSON(res, 200, await getCompanies());
  }
  if (url.pathname === '/api/companies' && req.method === 'POST') {
    const authUser = await authGuard(req, res);
    if (!authUser || authUser.role !== 1) return sendJSON(res, 403, { error: 'Admin only' });
    const body = await new Promise((res, rej) => { const c = []; req.on('data', d => c.push(d)); req.on('end', () => res(Buffer.concat(c).toString())); req.on('error', rej); });
    try { const { name } = JSON.parse(body); sendJSON(res, 200, await addCompany(name)); } catch (e) { sendJSON(res, 400, { error: e.message }); }
    return;
  }
  if (url.pathname.startsWith('/api/companies/') && (req.method === 'PUT' || req.method === 'DELETE')) {
    const authUser = await authGuard(req, res);
    if (!authUser || authUser.role !== 1) return sendJSON(res, 403, { error: 'Admin only' });
    const id = url.pathname.split('/').pop();
    if (req.method === 'DELETE') { const ok = await deleteCompany(id); return sendJSON(res, ok ? 200 : 404, ok ? { success: true } : { error: 'Not found' }); }
    const body = await new Promise((res, rej) => { const c = []; req.on('data', d => c.push(d)); req.on('end', () => res(Buffer.concat(c).toString())); req.on('error', rej); });
    try { const { name } = JSON.parse(body); const c = await updateCompany(id, name); sendJSON(res, c ? 200 : 404, c || { error: 'Not found' }); } catch (e) { sendJSON(res, 400, { error: e.message }); }
    return;
  }

  if (url.pathname === '/extract' && req.method === 'POST') {
    const user = await authGuard(req, res);
    if (!user) return;
    try {
      const boundary = getBoundary(req.headers['content-type']);
      if (!boundary) return sendJSON(res, 400, { error: 'No boundary' });

      const buf = await new Promise((res, rej) => {
        const c = []; req.on('data', d => c.push(d)); req.on('end', () => res(Buffer.concat(c))); req.on('error', rej);
      });
      const raw = buf.toString('latin1');
      const parts = raw.split(`--${boundary}`).filter(p => p.includes('name='));
      let file = null;
      const fields = {};

      for (const part of parts) {
        const trimmed = part.trim();
        if (trimmed === '' || trimmed === '--') continue;
        const hEnd = part.indexOf('\r\n\r\n');
        if (hEnd === -1) continue;
        const header = part.slice(0, hEnd);
        const body = part.slice(hEnd + 4);
        const name = header.match(/name="([^"]+)"/)?.[1];
        const fn = header.match(/filename="([^"]*)"/)?.[1];
        if (fn !== undefined) {
          const dataStr = body.endsWith('\r\n') ? body.slice(0, -2) : body;
          file = { data: Buffer.from(dataStr, 'latin1'), filename: fn || 'file' };
        } else if (name) {
          fields[name] = body.replace(/\r?\n$/, '');
        }
      }

      if (!file || !file.data || !file.filename) {
        return sendJSON(res, 400, { error: 'No file uploaded' });
      }
      const ext = extname(file.filename).slice(1).toLowerCase();
      if (!ALLOWED.includes(ext)) {
        return sendJSON(res, 400, { error: `Unsupported: ${ext}. Allowed: ${ALLOWED.join(', ')}` });
      }

      const jobId = crypto.randomBytes(8).toString('hex');
      const tplVal = (fields.template || '').trim();
      let tplName = tplVal && tplVal !== '__custom__' ? tplVal : null;
      if (tplName) {
        const tpls = await getTemplates();
        const tpl = tpls.find(t => t.id === tplName || t.name === tplName);
        if (tpl) tplName = tpl.name;
      }
      const wallStart = Date.now();
      jobs.set(jobId, { status: 'processing', page: 0, totalPages: 0 });
      await addJob(jobId, { fileName: file.filename, status: 'in-progress', schema: fields.schema || null, filter: fields.filter || null, templateName: tplName, createdAt: wallStart }, user.id);
      try { await updateJob(jobId, { storedFiles: await persistJobFiles(jobId, [file]) }); } catch (e) { console.error('persist failed', e); }

      (async () => {
        let tmpDir;
        try {
          tmpDir = await mkdtemp(join(tmpdir(), 'documind-'));
          const tmpPath = join(tmpDir, file.filename);
          await writeFile(tmpPath, file.data);

          const coreResult0 = applyPageRange(await convertDocument({ filePath: tmpPath, model, concurrency: 6, jobId }), fields.pages);
          jobs.set(jobId, { ...jobs.get(jobId), totalPages: coreResult0.pages.length });

          const { schemaUsed, filterUsed, verifyCoverage, verifyTotals, perPage, dateFormat, dateInputFormat, domain } = await parseSchema(fields);

          let coreResult = coreResult0;
          let markdown = null;

          if (schemaUsed) {
            const { data, reconciled, coverageAdjusted, coverageGap, usage: extractUsage, time: extractionTime, coreResult: usedCore } = await runExtractionWithFallback(coreResult0, schemaUsed, model, { verifyCoverage, verifyTotals, perPage, dateFormat, dateInputFormat, domain }, jobId);
            coreResult = usedCore || coreResult0;
            markdown = coreResult.pymupdfMarkdown || await generateMarkdownDocument(coreResult.pages);

            const conversionUsage = {
              inputTokens: coreResult.inputTokens || 0,
              outputTokens: coreResult.outputTokens || 0,
              timeMs: coreResult.completionTime || 0,
            };

            const filterConfig = (() => {
              try { const f = (fields.filter || filterUsed || '').trim(); return f ? parseFilterConfig(f) : null; } catch { return null; }
            })();
            const filterApplied = filterConfig ? applyFilter(data, filterConfig) : data;

            const totalInput = conversionUsage.inputTokens + (extractUsage.inputTokens || 0);
            const totalOutput = conversionUsage.outputTokens + (extractUsage.outputTokens || 0);

            const INPUT_PRICE = 0.15 / 1000000;
            const OUTPUT_PRICE = 0.60 / 1000000;
            const cost = totalInput * INPUT_PRICE + totalOutput * OUTPUT_PRICE;

            const meta = {
              pages: coreResult.pages.length,
              timing: { total: Date.now() - wallStart, conversion: conversionUsage.timeMs, extraction: extractionTime },
              tokens: { conversion: { input: conversionUsage.inputTokens, output: conversionUsage.outputTokens }, extraction: { input: extractUsage.inputTokens || 0, output: extractUsage.outputTokens || 0 }, total: { input: totalInput, output: totalOutput } },
              cost: { total: +cost.toFixed(6), inputPricePerM: 0.15, outputPricePerM: 0.60, currency: 'USD' },
              ...(reconciled ? { reconciledTotals: true } : {}),
              ...(coverageAdjusted ? { coverageAdjusted: true } : {}),
              ...(coverageGap ? { coverageGap } : {}),
            };

            const flags = { ...(reconciled ? { reconciledTotals: true } : {}), ...(coverageAdjusted ? { coverageAdjusted: true } : {}), ...(coverageGap ? { coverageGap } : {}) };
            jobs.set(jobId, { status: 'done', meta, data: { success: true, data: filterApplied, markdown, fileName: coreResult.fileName, ...flags } });
            await updateJob(jobId, { status: 'done', pages: coreResult.pages.length, timing: meta.timing, tokens: meta.tokens, cost: meta.cost, geminiCalls: coreResult.source === 'pymupdf' ? (extractUsage.calls || 0) : coreResult.pages.length + (extractUsage.calls || 1), resultData: { success: true, data: filterApplied, markdown, fileName: coreResult.fileName, ...flags } });
          } else {
            markdown = coreResult.pymupdfMarkdown || await generateMarkdownDocument(coreResult.pages);
            const markdownData = { success: true, pages: coreResult.pages.length, markdown, fileName: coreResult.fileName };
            jobs.set(jobId, { status: 'done', meta: { pages: coreResult.pages.length }, data: markdownData });
            await updateJob(jobId, { status: 'done', pages: coreResult.pages.length, geminiCalls: coreResult.source === 'pymupdf' ? 0 : coreResult.pages.length, timing: { total: Date.now() - wallStart }, cost: {}, resultData: markdownData });
          }
        } catch (err) {
          console.error(err);
          jobs.set(jobId, { status: 'error', meta: { error: err.message } });
          await updateJob(jobId, { status: 'error', error: err.message });
        } finally {
          if (tmpDir) await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
        }
      })();

      sendJSON(res, 200, { jobId, status: 'processing' });

    } catch (err) {
      console.error(err);
      sendJSON(res, 500, { error: err.message });
    }
    return;
  }

async function parseSchema(fields) {
  const templateId = (fields.template_id || fields.template || '').trim();
  let schemaUsed = null;
  let filterUsed = fields.filter == null ? null : typeof fields.filter === 'string' ? fields.filter : JSON.stringify(fields.filter);
  let verifyCoverage = fields.verify_coverage === '1' || fields.verify_coverage === 'true';
  let verifyTotals = fields.verify_totals !== '0' && fields.verify_totals !== 'false';
  let perPage = fields.per_page === '1' || fields.per_page === 'true';
  let dateFormat = fields.date_format ? String(fields.date_format).trim() : null;
  let dateInputFormat = fields.date_input_format ? String(fields.date_input_format).trim() : null;
  let domain = null;

  if (fields.schema && fields.schema.trim()) {
    try {
      let parsed = JSON.parse(fields.schema.trim());
      if (!Array.isArray(parsed)) {
        if (parsed.fields && Array.isArray(parsed.fields)) parsed = parsed.fields;
        else if (parsed.name && parsed.type) parsed = [parsed];
        else {
          const converted = jsonSchemaToDocumind(parsed);
          if (converted && converted.length > 0) parsed = converted;
        }
      }
      schemaUsed = parsed;
    } catch {}
  } else if (templateId) {
    const tpls = await getTemplates();
    const tpl = tpls.find(t => t.id === templateId || t.name === templateId);
    if (tpl && tpl.schema) {
      try {
        let parsed = JSON.parse(tpl.schema);
        if (!Array.isArray(parsed)) {
          if (parsed.fields && Array.isArray(parsed.fields)) parsed = parsed.fields;
          else if (parsed.name && parsed.type) parsed = [parsed];
          else {
            const converted = jsonSchemaToDocumind(parsed);
            if (converted && converted.length > 0) parsed = converted;
          }
        }
        schemaUsed = parsed;
        if (tpl.filter && !filterUsed) filterUsed = tpl.filter;
        if (!verifyCoverage && tpl.verifyCoverage) verifyCoverage = true;
        if (verifyTotals && tpl.verifyTotals === false) verifyTotals = false;
        if (tpl.perPage) perPage = true;
        if (!dateFormat && tpl.dateFormat) dateFormat = tpl.dateFormat;
        if (!dateInputFormat && tpl.dateInputFormat) dateInputFormat = tpl.dateInputFormat;
        if (tpl.domain && !domain) domain = tpl.domain;
      } catch {}
    }
  }
  return { schemaUsed, filterUsed, verifyCoverage, verifyTotals, perPage, dateFormat, dateInputFormat, domain };
}

async function startAsyncPipeline(jobId, file, fields, apiUser, model) {
  const { schemaUsed, filterUsed, verifyCoverage, verifyTotals, perPage, dateFormat, dateInputFormat, domain } = await parseSchema(fields);
  const tplId = (fields.template_id || fields.template || '').trim();
  let tplName = tplId || null;
  if (tplId) {
    const tpls = await getTemplates();
    const tpl = tpls.find(t => t.id === tplId || t.name === tplId);
    if (tpl) tplName = tpl.name;
  }
  const filterStr = fields.filter == null ? '' : typeof fields.filter === 'string' ? fields.filter : JSON.stringify(fields.filter);
  const finalFilter = filterStr.trim() || filterUsed || null;

  const tDir = await mkdtemp(join(tmpdir(), 'documind-'));
  const tPath = join(tDir, file.filename);
  await writeFile(tPath, file.data);
  const ext = file.filename?.split('.').pop()?.toLowerCase() || '';
  const pageCount = ext === 'pdf' ? await quickPageCount(tPath) : 0;
  const estimate = estimateTime(ext, pageCount, !!schemaUsed);

  jobs.set(jobId, { status: 'processing', eta: estimate.text });
  const wallStart = Date.now();
  await addJob(jobId, { fileName: file.filename, status: 'in-progress', pages: pageCount, schema: fields.schema || null, filter: finalFilter, templateName: tplName, apiKeyName: apiUser._apiKeyName || null, createdAt: wallStart }, apiUser.id);
  try { await updateJob(jobId, { storedFiles: await persistJobFiles(jobId, [file]) }); } catch (e) { console.error('persist failed', e); }

  (async () => {
    try {
      const coreRes0 = applyPageRange(await convertDocument({ filePath: tPath, model, concurrency: 6, jobId }), fields.pages);
      let coreRes = coreRes0;
      let md = null;

      if (!schemaUsed) {
        md = coreRes.pymupdfMarkdown || await generateMarkdownDocument(coreRes.pages);
        const markdownData = { success: true, pages: coreRes.pages.length, markdown: md, fileName: coreRes.fileName };
        jobs.set(jobId, { status: 'done', meta: { pages: coreRes.pages.length }, data: markdownData });
        await updateJob(jobId, { status: 'done', pages: coreRes.pages.length, geminiCalls: coreRes.source === 'pymupdf' ? 0 : coreRes.pages.length, timing: { total: Date.now() - wallStart }, resultData: markdownData });
      } else {
        const { data, reconciled, coverageAdjusted, coverageGap, usage: extUsage, time: extTime, coreResult: usedCore } = await runExtractionWithFallback(coreRes0, schemaUsed, model, { verifyCoverage, verifyTotals, perPage, dateFormat, dateInputFormat, domain }, jobId);
        coreRes = usedCore || coreRes0;
        md = coreRes.pymupdfMarkdown || await generateMarkdownDocument(coreRes.pages);

        let filterConfig = null;
        if (finalFilter) {
          filterConfig = parseFilterConfig(finalFilter);
        }
        const filtered = filterConfig ? applyFilter(data, filterConfig) : data;

        const convUsage = { inputTokens: coreRes.inputTokens || 0, outputTokens: coreRes.outputTokens || 0, timeMs: coreRes.completionTime || 0 };
        const tIn = convUsage.inputTokens + (extUsage.inputTokens || 0);
        const tOut = convUsage.outputTokens + (extUsage.outputTokens || 0);
        const INPUT_PRICE = 0.15 / 1000000;
        const OUTPUT_PRICE = 0.60 / 1000000;

        const meta = {
          pages: coreRes.pages.length,
          timing: { total: Date.now() - wallStart, conversion: convUsage.timeMs, extraction: extTime },
          tokens: { conversion: { input: convUsage.inputTokens, output: convUsage.outputTokens }, extraction: { input: extUsage.inputTokens || 0, output: extUsage.outputTokens || 0 }, total: { input: tIn, output: tOut } },
          cost: { total: +(tIn * INPUT_PRICE + tOut * OUTPUT_PRICE).toFixed(6), inputPricePerM: 0.15, outputPricePerM: 0.60, currency: 'USD' },
          ...(reconciled ? { reconciledTotals: true } : {}),
          ...(coverageAdjusted ? { coverageAdjusted: true } : {}),
          ...(coverageGap ? { coverageGap } : {}),
        };
        const flags = { ...(reconciled ? { reconciledTotals: true } : {}), ...(coverageAdjusted ? { coverageAdjusted: true } : {}), ...(coverageGap ? { coverageGap } : {}) };
        jobs.set(jobId, { status: 'done', meta, data: { success: true, data: filtered, markdown: md, fileName: coreRes.fileName, ...flags } });
        await updateJob(jobId, { status: 'done', pages: coreRes.pages.length, timing: meta.timing, tokens: meta.tokens, cost: meta.cost, geminiCalls: coreRes.source === 'pymupdf' ? (extUsage.calls || 0) : coreRes.pages.length + (extUsage.calls || 1), resultData: { success: true, data: filtered, markdown: md, fileName: coreRes.fileName, ...flags } });
      }
    } catch (err) {
      console.error(err);
      jobs.set(jobId, { status: 'error', meta: { error: err.message } });
      await updateJob(jobId, { status: 'error', error: err.message });
    } finally {
      await rm(tDir, { recursive: true, force: true }).catch(() => {});
    }
  })();

  return { status: 'processing', estimatedTime: estimate.text, estimatedTimeMs: estimate.ms, resultUrl: `/api/result/${jobId}` };
}

async function quickPageCount(filePath) {
  try {
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const execFileAsync = promisify(execFile);
    const { stdout } = await execFileAsync('gs', [
      '-dNOPAUSE', '-dBATCH', '-q', '-dQUIET', '-dNODISPLAY',
      '-c', `(${filePath}) (r) file runpdfbegin pdfpagecount = quit`,
    ]);
    return parseInt(stdout.trim(), 10);
  } catch { return 0; }
}

function setStatusMessage(jobId, message) {
  if (!jobId) return;
  const cur = jobs.get(jobId);
  if (cur) jobs.set(jobId, { ...cur, statusMessage: message });
  if (message) updateJob(jobId, { statusMessage: message }).catch(() => {});
}

async function runPymupdf(filePath) {
  const { execFile } = await import('child_process');
  const { promisify } = await import('util');
  const execFileAsync = promisify(execFile);
  const start = Date.now();
  const { stdout } = await execFileAsync('python3', [join(__dirname, 'pymupdf_to_markdown.py'), filePath], { maxBuffer: 512 * 1024 * 1024 });
  const firstBrace = stdout.indexOf('{');
  const lastBrace = stdout.lastIndexOf('}');
  const jsonText = firstBrace === -1 || lastBrace === -1 ? stdout : stdout.slice(firstBrace, lastBrace + 1);
  const result = JSON.parse(jsonText);
  if (!result || !Array.isArray(result.pages) || result.pages.length === 0) {
    throw new Error('pymupdf produced no pages');
  }
  return { result, elapsed: Date.now() - start };
}

function sanitizeFileName(filePath) {
  const endOfPath = filePath.split('/').pop() || '';
  const rawFileName = endOfPath.split('.')[0];
  return rawFileName.replace(/[^\w\s]/g, '').replace(/\s+/g, '_').toLowerCase().substring(0, 255);
}

async function convertDocument({ filePath, model, concurrency = 6, jobId }) {
  const ext = extname(filePath).slice(1).toLowerCase();
  let pymupdfMarkdown = null;
  let pymupdfPages = null;
  if (ext === 'pdf') {
    try {
      const { result, elapsed } = await runPymupdf(filePath);
      if (result.usable && Array.isArray(result.pages) && result.pages.length) {
        const md = result.pages.join('\n\n');
        setStatusMessage(jobId, 'Attempt 1 of 2');
        return {
          completionTime: elapsed,
          fileName: sanitizeFileName(filePath),
          inputTokens: 0,
          outputTokens: 0,
          pages: result.pages.map((content, i) => ({ content, page: i + 1, contentLength: content.length })),
          source: 'pymupdf',
          filePath,
          pymupdfMarkdown: md,
          pymupdfPages: result.pages,
        };
      }
      console.warn(`[pymupdf] usable=false (scannedShare=${result.scannedShare}); using enhanced VLM.`);
    } catch (e) {
      console.warn('[pymupdf] fast path unavailable; using enhanced VLM:', e.message);
    }
    setStatusMessage(jobId, 'Attempt 2 of 2 — enhanced VLM');
  }
  const core = await documind({ filePath, model, concurrency });
  return { ...core, source: 'gemini', filePath, pymupdfMarkdown, pymupdfPages };
}

function parsePageRange(str) {
  if (!str || typeof str !== 'string') return null;
  const set = new Set();
  for (const part of str.split(',')) {
    const p = part.trim();
    if (!p) continue;
    const m = p.match(/^(\d+)\s*-\s*(\d+)$/);
    if (m) { const a = +m[1], b = +m[2]; for (let i = Math.min(a, b); i <= Math.max(a, b); i++) set.add(i); }
    else if (/^\d+$/.test(p)) set.add(+p);
  }
  return set.size ? set : null;
}

function applyPageRange(coreResult, pageStr) {
  const set = parsePageRange(pageStr);
  if (!set) return coreResult;
  const pages = coreResult.pages.filter(p => set.has(p.page));
  if (!pages.length) return coreResult;
  let pymupdfMarkdown = coreResult.pymupdfMarkdown;
  if (Array.isArray(coreResult.pymupdfPages) && coreResult.pymupdfPages.length) {
    pymupdfMarkdown = coreResult.pymupdfPages.filter((_, i) => set.has(i + 1)).join('\n\n');
  }
  return { ...coreResult, pages, pymupdfMarkdown };
}

function hasExtractedData(data) {
  if (!data || typeof data !== 'object') return false;
  const values = Object.values(data).filter(v => v !== null && v !== undefined);
  if (!values.length) return false;
  return values.some(v =>
    (Array.isArray(v) && v.length > 0) ||
    (typeof v === 'object' && Object.keys(v).length > 0) ||
    (typeof v === 'string' && v.trim() !== '') ||
    typeof v === 'number'
  );
}

async function runExtractionWithFallback(coreResult, schemaUsed, model, opts = {}, jobId) {
  if (coreResult.source === 'pymupdf') {
    try {
      const res = await runExtraction(coreResult, schemaUsed, model, opts);
      if (hasExtractedData(res.data)) return { ...res, source: 'pymupdf', coreResult };
      console.warn('[pymupdf] extraction returned no data; retrying with enhanced VLM.');
    } catch (e) {
      console.warn('[pymupdf] extraction failed; retrying with enhanced VLM:', e.message);
    }
    setStatusMessage(jobId, 'Attempt 2 of 2 — enhanced VLM');
    const vlmCore = await documind({ filePath: coreResult.filePath, model, concurrency: 6 });
    const res = await runExtraction(vlmCore, schemaUsed, model, opts);
    return { ...res, source: 'gemini', coreResult: vlmCore };
  }
  const res = await runExtraction(coreResult, schemaUsed, model, opts);
  return { ...res, source: coreResult.source || 'gemini', coreResult };
}

function estimateTime(fileExt, pageCount, hasSchema) {
  const pages = pageCount || 1;
  const perPage = pages > 20 ? 8 : (hasSchema ? 12 : 6);
  const total = (5 + pages * perPage) * 1000;
  const ms = total;
  if (ms < 60000) return { ms, text: `${Math.round(ms/1000)}s` };
  return { ms, text: `~${Math.round(ms/60000)} min` };
}

function checkAuth(req, res) {
  if (!process.env.API_KEY) return true;
  const key = req.headers['x-api-key'] || req.headers['authorization']?.replace(/^Bearer\s+/i, '');
  if (key !== process.env.API_KEY) {
    sendJSON(res, 401, { error: 'Unauthorized' });
    return false;
  }
  return true;
}

  if ((url.pathname.startsWith('/api/result/') || url.pathname.startsWith('/api/data/')) && req.method === 'GET') {
    if (!await authGuard(req, res)) return;
    const isData = url.pathname.includes('/api/data/');
    const jobId = url.pathname.split('/').pop();
    const job = jobs.get(jobId);
    if (!job) return sendJSON(res, 404, { error: 'Job not found' });
    sendJSON(res, 200, isData ? job.data : {
      status: job.status, eta: job.eta, meta: job.meta, data: job.data || null,
    });
    if (job.status === 'done' || job.status === 'error') {
      setTimeout(() => jobs.delete(jobId), 120000);
    }
    return;
  }

  if (url.pathname.startsWith('/result/') && req.method === 'GET') {
    const jobId = url.pathname.split('/').pop();
    const job = jobs.get(jobId);
    if (!job) return sendJSON(res, 404, { error: 'Job not found' });
    sendJSON(res, 200, {
      status: job.status,
      eta: job.eta,
      meta: job.meta,
      data: job.data || null,
    });
    if (job.status === 'done' || job.status === 'error') {
      setTimeout(() => jobs.delete(jobId), 120000);
    }
    return;
  }

  if (url.pathname.startsWith('/data/') && req.method === 'GET') {
    const jobId = url.pathname.split('/').pop();
    const job = jobs.get(jobId);
    if (!job || job.status !== 'done') return sendJSON(res, 404, { error: 'Data not found' });
    sendJSON(res, 200, job.data);
    return;
  }

  if (url.pathname === '/api/extract' && req.method === 'POST') {
    try {
      const apiUser = await authGuard(req, res);
      if (!apiUser) return;

      const isAsync = url.searchParams.get('mode') === 'async';

      const boundary = getBoundary(req.headers['content-type']);
      if (!boundary) return sendJSON(res, 400, { error: 'No boundary' });

      const buf = await new Promise((res, rej) => {
        const c = []; req.on('data', d => c.push(d)); req.on('end', () => res(Buffer.concat(c))); req.on('error', rej);
      });
      const raw = buf.toString('latin1');
      const parts = raw.split(`--${boundary}`).filter(p => p.includes('name='));
      let file = null;
      const fields = {};

      for (const part of parts) {
        const trimmed = part.trim();
        if (trimmed === '' || trimmed === '--') continue;
        const hEnd = part.indexOf('\r\n\r\n');
        if (hEnd === -1) continue;
        const header = part.slice(0, hEnd);
        const body = part.slice(hEnd + 4);
        const name = header.match(/name="([^"]+)"/)?.[1];
        const fn = header.match(/filename="([^"]*)"/)?.[1];
        if (fn !== undefined) {
          const dataStr = body.endsWith('\r\n') ? body.slice(0, -2) : body;
          file = { data: Buffer.from(dataStr, 'latin1'), filename: fn || 'file' };
        } else if (name) {
          fields[name] = body.replace(/\r?\n$/, '');
        }
      }

      if (!file || !file.data || !file.filename) {
        return sendJSON(res, 400, { error: 'File is required' });
      }
      const ext = extname(file.filename).slice(1).toLowerCase();
      if (!ALLOWED.includes(ext)) {
        return sendJSON(res, 400, { error: `Unsupported file type: ${ext}. Allowed: ${ALLOWED.join(', ')}` });
      }

      const model = process.env.MODEL || 'gemini-2.5-flash';

      if (isAsync) {
        const jobId = crypto.randomBytes(8).toString('hex');
        const started = await startAsyncPipeline(jobId, file, fields, apiUser, model);
        return sendJSON(res, 200, { jobId, ...started });
      }

      const wallStart = Date.now();
      const tmpDir = await mkdtemp(join(tmpdir(), 'documind-'));
      const tmpPath = join(tmpDir, file.filename);
      await writeFile(tmpPath, file.data);
      const coreResult0 = applyPageRange(await convertDocument({ filePath: tmpPath, model, concurrency: 6 }), fields.pages);
      let coreResult = coreResult0;
      let markdown = null;

      const { schemaUsed, filterUsed, verifyCoverage, verifyTotals, perPage, dateFormat, dateInputFormat, domain } = await parseSchema(fields);

      let output;
      if (schemaUsed) {
        const { data, reconciled, coverageAdjusted, coverageGap, usage: extractUsage, time: extractionTime, coreResult: usedCore } = await runExtractionWithFallback(coreResult0, schemaUsed, model, { verifyCoverage, verifyTotals, perPage, dateFormat, dateInputFormat, domain });
        coreResult = usedCore || coreResult0;
        markdown = coreResult.pymupdfMarkdown || await generateMarkdownDocument(coreResult.pages);

        const conversionUsage = {
          inputTokens: coreResult.inputTokens || 0,
          outputTokens: coreResult.outputTokens || 0,
          timeMs: coreResult.completionTime || 0,
        };

        let filterConfig = null;
        if ((fields.filter || filterUsed || '').trim()) {
          try { filterConfig = JSON.parse(fields.filter || filterUsed); } catch {}
        }
        const filteredData = filterConfig ? applyFilter(data, filterConfig) : data;

        const totalInput = conversionUsage.inputTokens + (extractUsage.inputTokens || 0);
        const totalOutput = conversionUsage.outputTokens + (extractUsage.outputTokens || 0);
        const INPUT_PRICE = 0.15 / 1000000;
        const OUTPUT_PRICE = 0.60 / 1000000;
        const cost = totalInput * INPUT_PRICE + totalOutput * OUTPUT_PRICE;

        output = {
          success: true, pages: coreResult.pages.length, data: filteredData, fileName: coreResult.fileName,
          timing: { total: Date.now() - wallStart, conversion: conversionUsage.timeMs, extraction: extractionTime },
          tokens: { conversion: { input: conversionUsage.inputTokens, output: conversionUsage.outputTokens }, extraction: { input: extractUsage.inputTokens || 0, output: extractUsage.outputTokens || 0 }, total: { input: totalInput, output: totalOutput } },
          cost: { total: +cost.toFixed(6), inputPricePerM: 0.15, outputPricePerM: 0.60, currency: 'USD' },
          ...(reconciled ? { reconciledTotals: true } : {}),
          ...(coverageAdjusted ? { coverageAdjusted: true } : {}),
          ...(coverageGap ? { coverageGap } : {}),
        };
      } else {
        markdown = coreResult.pymupdfMarkdown || await generateMarkdownDocument(coreResult.pages);
        output = {
          success: true, pages: coreResult.pages.length, markdown, fileName: coreResult.fileName,
          timing: { total: Date.now() - wallStart, conversion: coreResult.completionTime },
          tokens: { conversion: { input: coreResult.inputTokens || 0, output: coreResult.outputTokens || 0 }, total: { input: coreResult.inputTokens || 0, output: coreResult.outputTokens || 0 } },
        };
      }

      await rm(tmpDir, { recursive: true, force: true });
      sendJSON(res, 200, output);

    } catch (err) {
      console.error(err);
      sendJSON(res, 500, { error: err.message });
    }
    return;
  }

  if (url.pathname === '/api/classify' && req.method === 'POST') {
    const apiUser = await authGuard(req, res);
    if (!apiUser) return;
    const boundary = getBoundary(req.headers['content-type']);
    if (!boundary) return sendJSON(res, 400, { error: 'No boundary' });

    const buf = await new Promise((res, rej) => { const c = []; req.on('data', d => c.push(d)); req.on('end', () => res(Buffer.concat(c))); req.on('error', rej); });
    const raw = buf.toString('latin1');
    const parts = raw.split(`--${boundary}`).filter(p => p.includes('name='));
    let file = null;
    for (const part of parts) {
      const trimmed = part.trim();
      if (trimmed === '' || trimmed === '--') continue;
      const hEnd = part.indexOf('\r\n\r\n');
      if (hEnd === -1) continue;
      const header = part.slice(0, hEnd);
      const fn = header.match(/filename="([^"]*)"/)?.[1];
      const body = part.slice(hEnd + 4);
      if (fn !== undefined) {
        const dataStr = body.endsWith('\r\n') ? body.slice(0, -2) : body;
        file = { data: Buffer.from(dataStr, 'latin1'), filename: fn || 'file' };
      }
    }
    if (!file) return sendJSON(res, 400, { error: 'File required' });

    const tDir = await mkdtemp(join(tmpdir(), 'documind-classify-'));
    const tPath = join(tDir, file.filename);
    await writeFile(tPath, file.data);

    try {
      const model = process.env.MODEL || 'gemini-2.5-flash';
      const classifyStart = Date.now();
      const coreResult = await convertDocument({ filePath: tPath, model, concurrency: 6 });
      const markdown = coreResult.pymupdfMarkdown || await generateMarkdownDocument(coreResult.pages);

      // Classification — dynamic prompt from templates
      // Hybrid classification: keywords first, Gemini fallback if ambiguous
      const tpls = (await getTemplates()).filter(t => t.name && t.keywords);
      const lowerMD = markdown.toLowerCase();

      // Step 1: Keyword matching
      const scored = tpls.map(tpl => {
        const keywords = tpl.keywords.split(',').map(k => k.trim().toLowerCase()).filter(k => k.length > 2);
        const hits = keywords.filter(k => lowerMD.includes(k));
        return { tpl, hits, matched: hits };
      }).sort((a, b) => b.hits.length - a.hits.length);

      const best = scored[0] || { tpl: null, hits: [] };
      const runnerUp = scored[1] || { hits: [] };
      let classification;

      const templateList = tpls.map(t => `${t.id} (${t.name}): ${t.keywords}`).join('\n');
      const runAiClassify = async extraCtx => {
        const base = getAiConfig().classifyPrompt.replace('{{TEMPLATES}}', templateList);
        const prompt = extraCtx ? `${base}\n\nKEYWORD ANALYSIS:\n${extraCtx}` : base;
        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        const clsModel = genAI.getGenerativeModel({ model, generationConfig: { maxOutputTokens: 16 } });
        const clsRes = await clsModel.generateContent(prompt + '\n\nDocument:\n' + markdown.slice(0, 6000));
        const clsText = clsRes.response.text().trim();
        const matched = tpls.find(t => clsText.includes(t.id));
        return matched
          ? { template_id: matched.id, template_name: matched.name, confidence: 'medium', method: 'ai' }
          : { template_id: 'Unknown', template_name: 'Unknown', confidence: 'low', method: 'ai' };
      };

      // Clear winner (3+ keyword hits, significant lead)
      if (best.hits.length >= 3 && (best.hits.length - runnerUp.hits.length) >= 1) {
        classification = { template_id: best.tpl.id, template_name: best.tpl.name, confidence: 'high', method: 'keywords' };
      } else if (best.hits.length >= 1) {
        // Ambiguous — ask Gemini with keyword context
        const allHits = scored.map(s => `${s.tpl.id} (${s.tpl.name}): matched ${s.hits.length} keywords [${s.hits.slice(0, 3).join(', ')}]`).join('\n');
        try {
          classification = await runAiClassify(allHits);
        } catch {
          classification = { template_id: 'Unknown', template_name: 'Unknown', confidence: 'low', method: 'ai-failed' };
        }
      } else {
        // No keyword hits — ask Gemini directly
        try {
          classification = await runAiClassify(null);
        } catch {
          classification = { template_id: 'Unknown', template_name: 'Unknown', confidence: 'low', method: 'ai-failed' };
        }
      }

      sendJSON(res, 200, {
        success: true,
        template_id: classification.template_id,
        template_name: classification.template_name,
        confidence: classification.confidence,
        method: classification.method,
        keywordHits: best.hits.length,
        matchedKeywords: best.hits,
        allScores: scored.map(s => ({ id: s.tpl.id, name: s.tpl.name, hits: s.hits.length, keywords: s.hits })),
        timing: { conversion: coreResult.completionTime },
        pages: coreResult.pages.length,
        fileName: file.filename,
      });
    } catch (e) {
      sendJSON(res, 500, { error: e.message });
    } finally {
      await rm(tDir, { recursive: true, force: true }).catch(() => {});
    }
    return;
  }

  if (url.pathname === '/api/templates' && req.method === 'GET') {
    if (!await authGuard(req, res)) return;
    return sendJSON(res, 200, await getTemplates());
  }

  if (url.pathname === '/api/templates' && req.method === 'POST') {
    if (!await authGuard(req, res)) return;
    const body = await new Promise((res, rej) => {
      const c = []; req.on('data', d => c.push(d)); req.on('end', () => res(Buffer.concat(c).toString())); req.on('error', rej);
    });
    try {
      const data = JSON.parse(body);
      const tpl = await addTemplate(data);
      sendJSON(res, 200, tpl);
    } catch (e) {
      sendJSON(res, 400, { error: e.message });
    }
    return;
  }

  if (url.pathname.startsWith('/api/templates/') && (req.method === 'PUT' || req.method === 'DELETE')) {
    if (!await authGuard(req, res)) return;
    const id = url.pathname.split('/').pop();
    if (req.method === 'DELETE') {
      const ok = await deleteTemplate(id);
      return sendJSON(res, ok ? 200 : 404, ok ? { success: true } : { error: 'Not found' });
    }
    const body = await new Promise((res, rej) => {
      const c = []; req.on('data', d => c.push(d)); req.on('end', () => res(Buffer.concat(c).toString())); req.on('error', rej);
    });
    try {
      const data = JSON.parse(body);
      const tpl = await updateTemplate(id, data);
      sendJSON(res, tpl ? 200 : 404, tpl || { error: 'Not found' });
    } catch (e) {
      sendJSON(res, 400, { error: e.message });
    }
    return;
  }

  if (url.pathname === '/api/schema/generate' && req.method === 'POST') {
    const apiUser = await authGuard(req, res);
    if (!apiUser) return;

    const boundary = getBoundary(req.headers['content-type']);
    if (!boundary) return sendJSON(res, 400, { error: 'No boundary' });

    let tmpDir;
    try {
      const buf = await new Promise((res, rej) => {
        const c = []; req.on('data', d => c.push(d)); req.on('end', () => res(Buffer.concat(c))); req.on('error', rej);
      });
      const raw = buf.toString('latin1');
      const parts = raw.split(`--${boundary}`).filter(p => p.includes('name='));
      const files = [];
      const fields = {};

      for (const part of parts) {
        const trimmed = part.trim();
        if (trimmed === '' || trimmed === '--') continue;
        const hEnd = part.indexOf('\r\n\r\n');
        if (hEnd === -1) continue;
        const header = part.slice(0, hEnd);
        const body = part.slice(hEnd + 4);
        const name = header.match(/name="([^"]+)"/)?.[1];
        const fn = header.match(/filename="([^"]*)"/)?.[1];
        if (fn !== undefined) {
          const dataStr = body.endsWith('\r\n') ? body.slice(0, -2) : body;
          files.push({ data: Buffer.from(dataStr, 'latin1'), filename: fn || 'file' });
        } else if (name) {
          fields[name] = body.replace(/\r?\n$/, '');
        }
      }

      if (!files.length) {
        return sendJSON(res, 400, { error: 'File is required' });
      }
      if (files.length > MAX_SCHEMA_FILES) {
        return sendJSON(res, 400, { error: `Rate limit for number of files: maximum ${MAX_SCHEMA_FILES} files` });
      }
      for (const f of files) {
        const ext = extname(f.filename).slice(1).toLowerCase();
        if (!SCHEMA_ALLOWED.includes(ext)) {
          return sendJSON(res, 400, { error: `Unsupported file type: ${ext}. Allowed: ${SCHEMA_ALLOWED.join(', ')}` });
        }
      }

      const model = fields.model || process.env.MODEL || 'gemini-2.5-flash';
      const instructions = (fields.instructions || '').trim() || undefined;

      tmpDir = await mkdtemp(join(tmpdir(), 'documind-schema-'));
      const docFiles = [];
      for (const f of files) {
        const uploadPath = join(tmpDir, f.filename);
        await writeFile(uploadPath, f.data);
        docFiles.push({ name: f.filename, path: uploadPath });
      }

      const jobId = crypto.randomBytes(8).toString('hex');
      const estimatedMs = docFiles.length * 25000 + 15000;
      const eta = estimatedMs < 60000 ? `~${Math.round(estimatedMs / 1000)}s` : `~${Math.round(estimatedMs / 60000)} min`;

      schemaJobs.set(jobId, { status: 'processing', eta, fileCount: docFiles.length });
      await addJob(jobId, { fileName: files[0].filename, status: 'in-progress', schema: null, filter: null, templateName: 'schema-generation', apiKeyName: apiUser._apiKeyName || null, createdAt: Date.now() }, apiUser.id);
      try { await updateJob(jobId, { storedFiles: await persistJobFiles(jobId, files) }); } catch (e) { console.error('persist failed', e); }

      (async () => {
        try {
          const result = await generateSchema({ files: docFiles, model, instructions });
          const usage = result.usage || {};
          const totalInput = usage.total?.input || 0;
          const totalOutput = usage.total?.output || 0;
          const INPUT_PRICE = 0.15 / 1000000;
          const OUTPUT_PRICE = 0.60 / 1000000;
          const cost = { total: +(totalInput * INPUT_PRICE + totalOutput * OUTPUT_PRICE).toFixed(6), inputPricePerM: 0.15, outputPricePerM: 0.60, currency: 'USD' };
          schemaJobs.set(jobId, { status: 'done', ...result, cost });
          await updateJob(jobId, { status: 'done', pages: result.files.reduce((s, f) => s + (f.pages || 0), 0), timing: { total: result.timing }, tokens: usage, cost, geminiCalls: result.files.length * 2, schema: result.schema, resultData: { success: true, schema: result.schema }, fileName: files[0].filename });
        } catch (jobErr) {
          console.error(jobErr);
          schemaJobs.set(jobId, { status: 'error', meta: { error: jobErr.message } });
          await updateJob(jobId, { status: 'error', error: jobErr.message });
        } finally {
          if (tmpDir) await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
        }
      })();

      return sendJSON(res, 200, { jobId, status: 'processing', estimatedTime: eta, estimatedTimeMs: estimatedMs, resultUrl: `/api/schema/result/${jobId}` });
    } catch (err) {
      if (tmpDir) await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      console.error(err);
      return sendJSON(res, 500, { error: err.message });
    }
  }

  if (url.pathname.startsWith('/api/schema/result/') && req.method === 'GET') {
    const apiUser = await authGuard(req, res);
    if (!apiUser) return;
    const jobId = url.pathname.split('/').pop();
    const job = schemaJobs.get(jobId);
    if (!job) return sendJSON(res, 404, { error: 'Job not found' });
    const { status, eta, schema, files, usage, timing, meta } = job;
    sendJSON(res, 200, { status, eta, schema, files, usage, timing, meta });
    if (status === 'done' || status === 'error') {
      setTimeout(() => schemaJobs.delete(jobId), 120000);
    }
    return;
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
    res.end();
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

const serverStartedAt = Date.now();
(async () => {
  await loadStore();
  await initDb();
  await loadStorageConfig();
  await loadAiConfig();
  // Mark any jobs left in-progress by a previous process BEFORE we start accepting
  // requests, so freshly-submitted jobs can't be mistaken for orphans.
  await markOrphanedJobsAsError(serverStartedAt);
  // Seed admin user if none exist
  if ((await getUsers()).length === 0) {
    const pw = crypto.randomBytes(8).toString('hex');
    const hash = await hashPassword(pw);
    const co = await addCompany('Neopxl');
    await addUser({ email: 'admin@neopxl.ai', password_hash: hash, role: 1, company_id: co?.id || '', company_name: 'Neopxl' });
    console.log('=== FIRST RUN ===');
    console.log('Admin login: admin@neopxl.ai');
    console.log('Admin password:', pw);
    console.log('================');
  }
  server.listen(PORT, () => {
    console.log(`Neopxl AI at http://localhost:${PORT}`);
  });
})();

function shutdown() {
  console.log('Shutting down...');
  closeDb().then(() => process.exit(0)).catch(() => process.exit(1));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('unhandledRejection', err => { console.error('UNHANDLED REJECTION:', err); });
process.on('uncaughtException', err => { console.error('UNCAUGHT EXCEPTION:', err); });
