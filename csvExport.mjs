export const CHARGES_HEADER = ['Date', 'AircraftRegistration', 'Flight Number', 'AC Type/MTOW', 'NetAmount', 'Tax', 'Tons', 'Status', 'FileName', 'Charges Type'];

export const DETAILS_HEADER = ['Key', 'Value'];

const CHARGES_FIELDS = [
  { header: 'Date', keys: ['date', 'flight_date', 'movement_date', 'landing_date', 'service_date', 'movementDate'] },
  { header: 'AircraftRegistration', keys: ['aircraft_registration', 'aircraftRegistration', 'registration', 'reg', 'tail_number', 'ac_reg'] },
  { header: 'Flight Number', keys: ['flight_number', 'flightNumber', 'flight', 'flt_no', 'flight_no'] },
  { header: 'AC Type/MTOW', keys: ['ac_type_mtow', 'acTypeMtow'] },
  { header: 'NetAmount', keys: ['net_amount', 'netAmount', 'net'] },
  { header: 'Tax', keys: ['tax', 'tax_amount', 'taxAmount'] },
  { header: 'Tons', keys: ['tons', 'mtow_tons', 'tonnage'] },
  { header: 'Status', keys: ['status'] },
  { header: 'FileName', keys: ['file_name', 'fileName', 'filename'] },
  { header: 'Charges Type', keys: ['charges_type', 'chargesType', 'charge_type', 'type'] },
];

const DETAIL_KEYS = [
  ['InvoiceDate', ['invoice_date', 'invoiceDate', 'invoice date']],
  ['Currency', ['currency']],
  ['GrossValue', ['gross_value', 'grossValue', 'gross', 'gross_amount']],
  ['Supplier', ['supplier']],
  ['InvoiceNumber', ['invoice_number', 'invoiceNumber', 'invoice_no', 'ref_number', 'reference_number', 'doc_number']],
  ['Entity', ['entity']],
  ['TotalAmount', ['total_amount', 'totalAmount', 'total', 'invoice_total', 'grand_total']],
  ['TaxAmount', ['tax_amount', 'taxAmount', 'vat_amount', 'vat']],
  ['Withholding', ['withholding', 'withholding_amount', 'whd', 'withholding_tax']],
  ['TaxCode', ['tax_code', 'taxCode']],
  ['Sector', ['sector']],
];

const ARRAY_CANDIDATES = ['landing_charges', 'charges', 'line_items', 'items', 'movements', 'rows', 'charge_lines'];

function unwrapResult(result, fallbackFileName) {
  if (!result || typeof result !== 'object') return { data: {}, fileName: fallbackFileName || '' };
  const fileName = result.fileName || result.file_name || fallbackFileName || '';
  let data = result;
  if (result.data && typeof result.data === 'object') data = result.data;
  return { data, fileName };
}

function getVal(obj, keys) {
  if (!obj || typeof obj !== 'object') return null;
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null) return obj[k];
  }
  const wanted = new Set(keys.map(k => k.toLowerCase().replace(/[^a-z0-9]+/g, '')));
  for (const k of Object.keys(obj)) {
    if (wanted.has(k.toLowerCase().replace(/[^a-z0-9]+/g, ''))) {
      const v = obj[k];
      if (v !== undefined && v !== null) return v;
    }
  }
  return null;
}

function acTypeValue(row) {
  const combined = getVal(row, ['ac_type_mtow', 'acTypeMtow']);
  if (combined !== null && String(combined).trim() !== '') return combined;
  const type = getVal(row, ['aircraft_type', 'aircraftType', 'ac_type']);
  const mtow = getVal(row, ['mtow']);
  if (type !== null && mtow !== null && String(type).trim() !== '' && String(mtow).trim() !== '') {
    return `${type}/${mtow}`;
  }
  if (type !== null && String(type).trim() !== '') return type;
  if (mtow !== null && String(mtow).trim() !== '') return String(mtow);
  return '';
}

function findChargesArray(data) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== 'object') return [];
  for (const k of ARRAY_CANDIDATES) {
    const v = data[k];
    if (Array.isArray(v)) return v;
  }
  for (const v of Object.values(data)) {
    if (Array.isArray(v) && v.length && typeof v[0] === 'object' && v[0] !== null) return v;
  }
  return [];
}

function collectDetailSources(data) {
  const sources = [data];
  if (data && typeof data === 'object') {
    for (const v of Object.values(data)) {
      if (v && typeof v === 'object' && !Array.isArray(v)) sources.push(v);
    }
  }
  return sources;
}

function csvVal(v) {
  if (v === null || v === undefined) return '';
  let s = typeof v === 'string' ? v : String(v);
  if (s === 'null' || s === 'undefined') return '';
  if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

export function chargesCsv(result, fallbackFileName) {
  const { data, fileName } = unwrapResult(result, fallbackFileName);
  const rows = findChargesArray(data);
  const lines = [CHARGES_HEADER.join(',')];
  for (const row of rows) {
    const fields = CHARGES_FIELDS.map(f => {
      if (f.header === 'FileName') return csvVal(fileName);
      if (f.header === 'AC Type/MTOW') return csvVal(acTypeValue(row));
      return csvVal(getVal(row, f.keys));
    });
    lines.push(fields.join(','));
  }
  return lines.join('\n');
}

export function detailsCsv(result, fallbackFileName) {
  const { data } = unwrapResult(result, fallbackFileName);
  const sources = collectDetailSources(data);
  const lines = ['Key,Value'];
  for (const [label, keys] of DETAIL_KEYS) {
    let value = null;
    for (const src of sources) {
      const v = getVal(src, keys);
      if (v !== null && v !== undefined && String(v).trim() !== '') { value = v; break; }
    }
    lines.push(`${csvVal(label)},${csvVal(value)}`);
  }
  return lines.join('\n');
}

export function buildCsvExport(result, fallbackFileName) {
  const { fileName } = unwrapResult(result, fallbackFileName);
  const charges = chargesCsv(result, fallbackFileName);
  const details = detailsCsv(result, fallbackFileName);
  const rowCount = Math.max(0, charges.split('\n').length - 1);
  return { fileName, charges, details, rowCount };
}
