import test from 'node:test';
import assert from 'node:assert/strict';
import { dropUnidentifiedSummaryRows } from '../rowGuards.mjs';

const arrayField = {
  name: 'landing_charges',
  type: 'array',
  items: {
    properties: {
      date: { type: 'string' },
      flight_number: { type: 'string' },
      aircraft_registration: { type: 'string' },
      airport: { type: 'string' },
      description: { type: 'string' },
      charges_type: { type: 'string' },
      net_amount: { type: 'number' },
    },
  },
};

const identified = (i) => ({
  date: `2026-09-${String((i % 28) + 1).padStart(2, '0')}`,
  flight_number: `XY${100 + i}`,
  aircraft_registration: 'A6-ABC',
  description: 'Landing',
  charges_type: 'LANDING FEES',
  net_amount: 100 + i,
});

const summary = (desc, amount) => ({
  date: null,
  flight_number: null,
  aircraft_registration: null,
  description: desc,
  charges_type: desc,
  net_amount: amount,
});

const landing38 = [
  summary('LandingCharges:', 30761.25),
  summary('Night-LandingCharges:', 1471.36),
  summary('Night-Takeoff Charges:', 1187.62),
  ...Array.from({ length: 35 }, (_, i) => identified(i)),
];

test('drops the 3 page-1 summary rows from the 38-row landing result', () => {
  const res = dropUnidentifiedSummaryRows(landing38, arrayField);
  assert.equal(res.dropped, 3);
  assert.equal(res.rows.length, 35);
  assert.equal(res.rows.some((r) => r.description === 'LandingCharges:'), false);
});

test('does not mutate the input rows', () => {
  const copy = JSON.parse(JSON.stringify(landing38));
  dropUnidentifiedSummaryRows(landing38, arrayField);
  assert.deepEqual(landing38, copy);
});

test('safety valve: leaves rows untouched when fewer than 80% are identified', () => {
  const rows = [...Array.from({ length: 2 }, () => summary('LandingCharges:', 10)), ...Array.from({ length: 2 }, (_, i) => identified(i))];
  const res = dropUnidentifiedSummaryRows(rows, arrayField);
  assert.equal(res.dropped, 0);
  assert.equal(res.rows.length, 4);
  assert.equal(res.reason, 'below-identified-ratio');
});

test('does nothing for a non-array field', () => {
  const res = dropUnidentifiedSummaryRows(landing38, { name: 'customer', type: 'object' });
  assert.equal(res.dropped, 0);
  assert.equal(res.rows.length, 38);
});

test('does nothing when the item schema has no identity (string) fields', () => {
  const numericOnly = { name: 'x', type: 'array', items: { properties: { description: { type: 'string' }, amount: { type: 'number' } } } };
  const rows = [{ description: 'a', amount: 1 }, { description: 'b', amount: 2 }];
  const res = dropUnidentifiedSummaryRows(rows, numericOnly);
  assert.equal(res.dropped, 0);
  assert.equal(res.rows.length, 2);
  assert.equal(res.reason, 'no-identity-fields');
});

test('keeps fully identified rows exactly as they are', () => {
  const rows = Array.from({ length: 35 }, (_, i) => identified(i));
  const res = dropUnidentifiedSummaryRows(rows, arrayField);
  assert.equal(res.dropped, 0);
  assert.equal(res.rows.length, 35);
});

test('works with the converted internal schema shape (children instead of items)', () => {
  const converted = {
    name: 'landing_charges',
    type: 'array',
    children: [
      { name: 'date', type: 'string' },
      { name: 'flight_number', type: 'string' },
      { name: 'aircraft_registration', type: 'string' },
      { name: 'description', type: 'string' },
      { name: 'charges_type', type: 'string' },
      { name: 'net_amount', type: 'number' },
    ],
  };
  const res = dropUnidentifiedSummaryRows(landing38, converted);
  assert.equal(res.dropped, 3);
  assert.equal(res.rows.length, 35);
});

test('ignores context fields that are identical on every row (e.g. airport)', () => {
  const withAirport = (row) => ({ ...row, airport: 'Hazrat Shahjalal International Airport' });
  const rows = landing38.map(withAirport);
  const res = dropUnidentifiedSummaryRows(rows, arrayField);
  assert.equal(res.dropped, 3);
  assert.equal(res.rows.length, 35);
});

test('ignores low-cardinality context fields even when they take two values', () => {
  const rows = landing38.map((row, i) => ({
    ...row,
    airport: i < 20 ? 'Hazrat Shahjalal International Airport' : 'Osmani International Airport',
  }));
  const res = dropUnidentifiedSummaryRows(rows, arrayField);
  assert.equal(res.dropped, 3);
  assert.equal(res.rows.length, 35);
});

const detailField = {
  name: 'landing_charges',
  type: 'array',
  items: {
    properties: {
      date: { type: 'string' },
      aircraft_registration: { type: 'string' },
      flight_number: { type: 'string' },
      ata: { type: 'string' },
      atd: { type: 'string' },
      description: { type: 'string' },
      quantity: { type: 'number' },
      net_amount: { type: 'number' },
      tax: { type: 'number' },
      line_total: { type: 'number' },
    },
  },
};

const detailRow = (i) => ({
  date: `2026-09-${String((i % 8) + 8).padStart(2, '0')}`,
  aircraft_registration: `A6AU${String.fromCharCode(65 + (i % 20))}`,
  flight_number: ['3L133', '3L131', '3L248'][i % 3],
  ata: `${String(5 + (i % 12)).padStart(2, '0')}:00`,
  atd: `${String(5 + (i % 12)).padStart(2, '0')}:30`,
  description: 'Landing Charge - Int.',
  quantity: 1,
  net_amount: 157850,
  tax: 314860,
  line_total: 472710,
});

const invoiceSummary = (count) => ({
  date: '2026-09-15',
  aircraft_registration: null,
  flight_number: null,
  ata: null,
  atd: null,
  description: 'LANDING CHARGE INTERNATIONAL',
  quantity: count,
  net_amount: 157850 * count,
  tax: 653499,
  line_total: 4284049,
});

test('drops a dated page-1 invoice line when its amount is the sum of the detail rows', () => {
  // Invoice 193200001475: one invoice line for 23 landings + 23 annexure rows.
  const rows = [invoiceSummary(23), ...Array.from({ length: 23 }, (_, i) => detailRow(i))];
  const res = dropUnidentifiedSummaryRows(rows, detailField);
  assert.equal(res.dropped, 1);
  assert.equal(res.rows.length, 23);
  assert.equal(res.rows.some((r) => r.description === 'LANDING CHARGE INTERNATIONAL'), false);
});

test('drops a dated aggregate for a different row count', () => {
  const rows = [invoiceSummary(16), ...Array.from({ length: 16 }, (_, i) => detailRow(i))];
  const res = dropUnidentifiedSummaryRows(rows, detailField);
  assert.equal(res.dropped, 1);
  assert.equal(res.rows.length, 16);
});

test('keeps a fully identified row even when its amount equals the sum of the others', () => {
  const rows = [
    { ...detailRow(0), net_amount: 100 },
    { ...detailRow(1), net_amount: 100 },
    { ...detailRow(2), net_amount: 100 },
    { ...detailRow(3), net_amount: 300 },
  ];
  const res = dropUnidentifiedSummaryRows(rows, detailField);
  assert.equal(res.dropped, 0);
  assert.equal(res.rows.length, 4);
});

test('keeps a sparse dated row whose amount is not the sum of the detail rows', () => {
  const rows = [invoiceSummary(23), ...Array.from({ length: 23 }, (_, i) => detailRow(i))];
  rows[0] = { ...rows[0], net_amount: 999 };
  const res = dropUnidentifiedSummaryRows(rows, detailField);
  assert.equal(res.dropped, 0);
  assert.equal(res.rows.length, 24);
});

test('leaves small arrays alone even when one amount equals the sum', () => {
  const rows = [invoiceSummary(2), { ...detailRow(0), net_amount: 157850 }, { ...detailRow(1), net_amount: 157850 }];
  const res = dropUnidentifiedSummaryRows(rows, detailField);
  assert.equal(res.dropped, 0);
  assert.equal(res.rows.length, 3);
});
