import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeCurrencyFields,
  findCurrencyFieldGroups,
  reconcileCurrencyAmounts,
  documentCurrencyCode,
} from '../currencyFields.mjs';

const landingSchema = () => ([
  { name: 'currency', type: 'string' },
  {
    name: 'landing_charges',
    type: 'array',
    children: [
      { name: 'description', type: 'string' },
      { name: 'net_amount', type: 'number' },
      { name: 'line_total_aed', type: 'number', description: 'The total amount for the line item in AED, including tax.' },
      { name: 'line_total_usd', type: 'number', description: 'The total amount for the line item in USD, including tax.' },
    ],
  },
]);

test('adds a neutral field for currency-suffixed amount groups', () => {
  const schema = normalizeCurrencyFields(landingSchema());
  const items = schema[1].children;
  assert.ok(items.some((f) => f.name === 'line_total' && f.type === 'number'));
  assert.ok(items.some((f) => f.name === 'line_total_aed'));
  assert.ok(items.some((f) => f.name === 'line_total_usd'));
});

test('normalization is idempotent', () => {
  const once = normalizeCurrencyFields(landingSchema());
  const firstDescription = once[1].children.find((f) => f.name === 'line_total_aed').description;
  const twice = normalizeCurrencyFields(once);
  const secondDescription = twice[1].children.find((f) => f.name === 'line_total_aed').description;
  assert.equal(secondDescription, firstDescription);
  assert.equal(twice[1].children.filter((f) => f.name === 'line_total').length, 1);
});

test('does not touch schemas without currency-suffixed amount fields', () => {
  const schema = [
    { name: 'currency', type: 'string' },
    { name: 'invoice_total', type: 'number' },
    { name: 'reference_usd', type: 'string' },
  ];
  const before = JSON.stringify(schema);
  normalizeCurrencyFields(schema);
  assert.equal(JSON.stringify(schema), before);
});

test('leaves a lone currency-suffixed field untouched', () => {
  // Fuel Invoices has total_vat_0_percent_sar and nothing else in that group.
  // Its suffix is unambiguous, so neither the schema nor the output may change.
  const schema = [{ name: 'currency', type: 'string' }, { name: 'total_vat_0_percent_sar', type: 'number' }];
  const before = JSON.stringify(schema);
  normalizeCurrencyFields(schema);
  assert.equal(JSON.stringify(schema), before);
  assert.deepEqual(findCurrencyFieldGroups(schema), []);
});

test('ignores three-letter suffixes that are not currency codes', () => {
  const schema = [{ name: 'total_net', type: 'number' }, { name: 'code_abc', type: 'number' }];
  const before = JSON.stringify(schema);
  normalizeCurrencyFields(schema);
  assert.equal(JSON.stringify(schema), before);
});

test('finds groups inside nested arrays and objects', () => {
  const schema = normalizeCurrencyFields([
    {
      name: 'invoices',
      type: 'array',
      children: [
        { name: 'invoice_no', type: 'string' },
        {
          name: 'charges',
          type: 'array',
          children: [
            { name: 'amount_eur', type: 'number' },
            { name: 'amount_gbp', type: 'number' },
          ],
        },
      ],
    },
  ]);
  const groups = findCurrencyFieldGroups(schema);
  const nested = groups.find((g) => g.base === 'amount');
  assert.deepEqual(nested.path, ['invoices', 'charges']);
  assert.equal(nested.neutralExists, true);
  assert.equal(schema[0].children[1].children.filter((f) => f.name === 'amount').length, 1);
});

test('normalizes a document currency name or symbol to an ISO code', () => {
  assert.equal(documentCurrencyCode('INR'), 'INR');
  assert.equal(documentCurrencyCode('Indian Rupee'), 'INR');
  assert.equal(documentCurrencyCode('EURO'), 'EUR');
  assert.equal(documentCurrencyCode('US Dollar'), 'USD');
  assert.equal(documentCurrencyCode('د.إ'), 'AED');
  assert.equal(documentCurrencyCode('₹'), 'INR');
  assert.equal(documentCurrencyCode('EUR 1,234'), 'EUR');
  assert.equal(documentCurrencyCode('not a currency'), null);
  assert.equal(documentCurrencyCode(null), null);
});

test('moves an INR total out of line_total_aed into line_total', () => {
  const schema = normalizeCurrencyFields(landingSchema());
  const groups = findCurrencyFieldGroups(schema);
  const data = {
    currency: 'INR',
    landing_charges: [
      { description: 'Landing Charge', net_amount: 157850, line_total_aed: 467250, line_total_usd: null },
      { description: 'Other', net_amount: 100, line_total_aed: null, line_total_usd: null },
    ],
  };
  const result = reconcileCurrencyAmounts(data, groups, data.currency);
  assert.equal(result.moved, 1);
  assert.equal(data.landing_charges[0].line_total, 467250);
  assert.equal(data.landing_charges[0].line_total_aed, null);
  assert.equal(data.landing_charges[1].line_total, undefined);
});

test('prefers the variant that matches the document currency', () => {
  const schema = normalizeCurrencyFields(landingSchema());
  const groups = findCurrencyFieldGroups(schema);
  const data = {
    currency: 'USD',
    landing_charges: [
      { line_total_aed: 0, line_total_usd: 330.09 },
    ],
  };
  reconcileCurrencyAmounts(data, groups, data.currency);
  assert.equal(data.landing_charges[0].line_total, 330.09);
  assert.equal(data.landing_charges[0].line_total_usd, null);
  assert.equal(data.landing_charges[0].line_total_aed, 0);
});

test('moves a single populated variant even when the document currency is unknown', () => {
  const schema = normalizeCurrencyFields(landingSchema());
  const groups = findCurrencyFieldGroups(schema);
  const data = { landing_charges: [{ line_total_usd: 12.5 }] };
  reconcileCurrencyAmounts(data, groups, undefined);
  assert.equal(data.landing_charges[0].line_total, 12.5);
  assert.equal(data.landing_charges[0].line_total_usd, null);
});

test('leaves genuinely different multi-currency values untouched', () => {
  const schema = normalizeCurrencyFields(landingSchema());
  const groups = findCurrencyFieldGroups(schema);
  const data = {
    currency: 'INR',
    landing_charges: [{ line_total_aed: 100, line_total_usd: 200 }],
  };
  const result = reconcileCurrencyAmounts(data, groups, data.currency);
  assert.equal(result.moved, 0);
  assert.equal(data.landing_charges[0].line_total, undefined);
  assert.equal(data.landing_charges[0].line_total_aed, 100);
  assert.equal(data.landing_charges[0].line_total_usd, 200);
});

test('clears suffixed duplicates when the neutral field is already populated', () => {
  const schema = normalizeCurrencyFields(landingSchema());
  const groups = findCurrencyFieldGroups(schema);
  const data = {
    currency: 'INR',
    landing_charges: [{ line_total: 467250, line_total_aed: 467250 }],
  };
  reconcileCurrencyAmounts(data, groups, data.currency);
  assert.equal(data.landing_charges[0].line_total, 467250);
  assert.equal(data.landing_charges[0].line_total_aed, null);
});

test('preserves a real zero amount', () => {
  const schema = normalizeCurrencyFields(landingSchema());
  const groups = findCurrencyFieldGroups(schema);
  const data = { currency: 'INR', landing_charges: [{ line_total_aed: 0, line_total_usd: 0 }] };
  reconcileCurrencyAmounts(data, groups, data.currency);
  assert.equal(data.landing_charges[0].line_total, 0);
});

test('reconciliation is a no-op when there are no groups', () => {
  const data = { currency: 'INR', amount: 5 };
  const result = reconcileCurrencyAmounts(data, [], 'INR');
  assert.equal(result.moved, 0);
  assert.equal(data.amount, 5);
});
