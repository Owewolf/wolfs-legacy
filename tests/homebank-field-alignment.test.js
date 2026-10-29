'use strict';

// Synthetic accounts and in-memory SQLite only. This suite never opens the
// configured HomeBank directory, application database, or personal vault.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Database = require('better-sqlite3');
process.env.ENCRYPTION_KEY = 'ef'.repeat(32);
process.env.HOMEBANK_OWNER_EMAIL = 'alignment-fixture@example.test';
const { encrypt, decrypt } = require('../server/crypto');
const { projectHomebankEntry, sanitizeHomebankEntry, clearStoredHomebankLedger, sourceBalanceField } = require('../server/homebank-vault');

const SECTIONS = vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../public/js/sections.js'), 'utf8') + '\nSECTIONS;');
const FINANCIAL_SECTIONS = ['bank_accounts', 'investments', 'retirement', 'debts', 'real_estate', 'vehicles'];

function source(type, overrides = {}) {
  return { id: 17, name: 'Synthetic account', type_id: type, today: -1234.56,
    currency: 'ZAR', group_name: '', closed: false, excluded_from_summary: false, ...overrides };
}

function entry(section, fields = {}) {
  return { id: 23, user_id: 41, section, title: 'Synthetic linked record',
    homebank_account_id: 17, fields, notes: 'Old copied HomeBank notes' };
}

function visibility(account) {
  return { accountForEntry: () => account };
}

function project(section, fields, account) {
  return projectHomebankEntry(entry(section, fields), visibility(account));
}

function cleanupDatabase() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT);
    CREATE TABLE homebank_snapshots (user_id INTEGER PRIMARY KEY, snapshot_encrypted TEXT);
    CREATE TABLE vault_entries (id INTEGER PRIMARY KEY, user_id INTEGER, section TEXT,
      fields_encrypted TEXT, notes_encrypted TEXT, homebank_account_id INTEGER,
      created_at TEXT, updated_at TEXT);`);
  db.prepare('INSERT INTO users VALUES (?,?)').run(41, process.env.HOMEBANK_OWNER_EMAIL);
  return db;
}

function assertManagedFormFields(projected) {
  const form = SECTIONS[projected.section];
  for (const key of projected.homebank_managed_fields) {
    if (key === 'notes') continue;
    const field = form.fields.find(candidate => candidate.key === key);
    assert.ok(field, `${projected.section}.${key} must have a matching form control`);
    if (field.type === 'select' && projected.fields[key]) {
      assert.ok(field.options.includes(projected.fields[key]), `${projected.fields[key]} must be an available ${key} option`);
    }
  }
}

test('asset vehicle valuation is separate from owner loan details and does not invent a bank lender', () => {
  const fields = { current_value: 'Stale copied valuation', loan_balance: 'ZAR -456.78',
    loan_provider: 'Owner lender', registration: 'FIXTURE-17' };
  const before = structuredClone(fields);
  const projected = project('vehicles', fields, source(3, { bank_name: 'Synthetic asset custodian' }));
  assert.equal(projected.fields.current_value, 'ZAR -1234.56');
  assert.equal(projected.fields.loan_balance, 'ZAR -456.78');
  assert.equal(projected.fields.loan_provider, 'Owner lender');
  assert.ok(projected.homebank_managed_fields.includes('current_value'));
  assert.ok(!projected.homebank_managed_fields.includes('loan_balance'));
  assert.ok(!projected.homebank_managed_fields.includes('loan_provider'));
  assert.equal(projected.fields.registration, 'FIXTURE-17');
  assert.equal(projected.notes, '');
  assert.deepEqual(fields, before, 'Projection must not mutate the stored owner details');
  assertManagedFormFields(projected);
});

test('property assets retain the owner mortgage and use current value without inferring a lender', () => {
  const projected = project('real_estate', { current_value: 'Old source value', mortgage_balance: 'ZAR 987.65',
    mortgage_provider: 'Owner mortgage lender', address: 'Synthetic address' },
  source(3, { bank_name: 'Synthetic asset custodian', currency: 'EUR', today: 27.31 }));
  assert.equal(projected.fields.current_value, 'EUR 27.31');
  assert.equal(projected.fields.mortgage_balance, 'ZAR 987.65');
  assert.equal(projected.fields.mortgage_provider, 'Owner mortgage lender');
  assert.ok(!projected.homebank_managed_fields.includes('mortgage_balance'));
  assert.ok(!projected.homebank_managed_fields.includes('mortgage_provider'));
  assertManagedFormFields(projected);
});

test('explicit liability records use loan fields on historical asset forms and outstanding in debts', () => {
  for (const type of [4, 5]) {
    for (const [section, ledgerField, ownerField] of [
      ['vehicles', 'loan_balance', 'current_value'],
      ['real_estate', 'mortgage_balance', 'current_value'],
      ['debts', 'outstanding', 'monthly_payment'],
    ]) {
      const projected = project(section, { [ledgerField]: 'Stale source ledger', [ownerField]: 'Owner value' },
        source(type, { today: -88.01, currency: 'USD', group_name: 'Synthetic finance group' }));
      assert.equal(projected.fields[ledgerField], 'USD -88.01');
      assert.equal(projected.fields[ownerField], 'Owner value');
      assert.ok(projected.homebank_managed_fields.includes(ledgerField));
      assert.ok(!projected.homebank_managed_fields.includes(ownerField));
      assertManagedFormFields(projected);
    }
  }
});

test('known source kinds populate only compatible balance fields and untyped snapshots keep their legacy view', () => {
  const bank = { bank_accounts: 'balance_approx', investments: 'value_approx', retirement: 'value_approx' };
  const asset = { investments: 'value_approx', retirement: 'value_approx', real_estate: 'current_value', vehicles: 'current_value' };
  const liability = { debts: 'outstanding', real_estate: 'mortgage_balance', vehicles: 'loan_balance' };
  for (const [type, expected] of [[0, {}], [1, bank], [2, bank], [3, asset],
    [4, liability], [5, liability], [6, bank], [7, bank]]) {
    for (const section of FINANCIAL_SECTIONS) {
      assert.equal(sourceBalanceField(section, source(type)), expected[section], `${section} for source type ${type}`);
    }
  }
  assert.equal(sourceBalanceField('vehicles', source(undefined)), 'loan_balance');
  assert.equal(sourceBalanceField('debts', source(undefined)), 'outstanding');
});

test('incompatible source kinds do not manufacture debt amounts, lenders, or investment valuations', () => {
  for (const [type, section, amountKey, providerKey] of [
    [3, 'debts', 'outstanding', 'creditor'],
    [3, 'bank_accounts', 'balance_approx', 'bank_name'],
    [4, 'investments', 'value_approx', 'institution'],
    [5, 'retirement', 'value_approx', 'provider'],
    [6, 'real_estate', 'current_value', 'mortgage_provider'],
    [7, 'vehicles', 'loan_balance', 'loan_provider'],
  ]) {
    const account = source(type, { name: 'FNB Synthetic custodian account', bank_name: 'Synthetic custodian' });
    const fields = { [amountKey]: 'Owner entered amount', [providerKey]: 'Owner entered provider' };
    const projected = project(section, fields, account);
    assert.equal(projected.fields[amountKey], 'Owner entered amount', `${section} amount is not a source ${type} ledger`);
    assert.equal(projected.fields[providerKey], 'Owner entered provider');
    assert.ok(!projected.homebank_managed_fields.includes(amountKey));
    assert.ok(!projected.homebank_managed_fields.includes(providerKey));
    assert.deepEqual(sanitizeHomebankEntry(projected, visibility(account)).fields, fields);
    const blank = project(section, {}, account);
    assert.equal(blank.fields[amountKey], undefined);
    assert.equal(blank.fields[providerKey], undefined);
  }
});

test('checking and savings source types select the correct form option with current institution metadata', () => {
  for (const [type, expected] of [[6, 'Current / Checking'], [7, 'Savings']]) {
    const projected = project('bank_accounts', { account_type: 'Other', bank_name: 'Stale bank',
      nominee: 'Owner nominee' }, source(type, { bank_name: 'Synthetic current bank',
      account_number: 'SYNTHETIC-17', website: 'https://bank.example.test/', group_name: 'Synthetic accounts' }));
    assert.equal(projected.fields.account_type, expected);
    assert.equal(projected.fields.bank_name, 'Synthetic current bank');
    assert.equal(projected.fields.account_number, 'SYNTHETIC-17');
    assert.equal(projected.fields.online_url, 'https://bank.example.test/');
    assert.equal(projected.fields.nominee, 'Owner nominee');
    for (const key of ['account_type', 'bank_name', 'account_number', 'online_url', 'homebank_group']) {
      assert.ok(projected.homebank_managed_fields.includes(key), `${key} must be source managed`);
    }
    assertManagedFormFields(projected);
  }
});

test('a retirement annuity uses its source classification and provider without overriding its underlying investment', () => {
  const account = source(7, { group_name: 'Retirement Annuity', bank_name: 'Synthetic retirement provider',
    account_number: 'SYNTHETIC-ANNUITY-17', website: 'https://retirement.example.test/' });
  const projected = project('retirement', { type: 'Other', investment_type: 'Owner balanced fund',
    beneficiary: 'Owner beneficiary' }, account);
  assert.equal(projected.fields.type, 'Annuity');
  assert.equal(projected.fields.provider, 'Synthetic retirement provider');
  assert.equal(projected.fields.account_number, 'SYNTHETIC-ANNUITY-17');
  assert.equal(projected.fields.login_url, 'https://retirement.example.test/');
  assert.equal(projected.fields.value_approx, 'ZAR -1234.56');
  assert.equal(projected.fields.investment_type, 'Owner balanced fund');
  assert.equal(projected.fields.beneficiary, 'Owner beneficiary');
  for (const key of ['type', 'provider', 'account_number', 'login_url', 'value_approx', 'homebank_group']) {
    assert.ok(projected.homebank_managed_fields.includes(key));
  }
  assert.ok(!projected.homebank_managed_fields.includes('investment_type'));
  assertManagedFormFields(projected);
  const stored = sanitizeHomebankEntry(projected, visibility(account));
  assert.deepEqual(stored.fields, { investment_type: 'Owner balanced fund', beneficiary: 'Owner beneficiary' });
});

test('all linked financial forms expose current group metadata, including clearing a removed group', () => {
  for (const section of FINANCIAL_SECTIONS) {
    const account = source(section === 'debts' ? 5 : 3, { group_name: 'Synthetic group' });
    const projected = project(section, { homebank_group: 'Old group' }, account);
    assert.equal(projected.fields.homebank_group, 'Synthetic group');
    assert.ok(projected.homebank_managed_fields.includes('homebank_group'));
    assertManagedFormFields(projected);
    account.group_name = '';
    const cleared = projectHomebankEntry(projected, visibility(account));
    assert.equal(cleared.fields.homebank_group, '');
    assert.ok(cleared.homebank_managed_fields.includes('homebank_group'));
    assert.equal(sanitizeHomebankEntry(cleared, visibility(account)).fields.homebank_group, undefined);
  }
});

test('editing and restoring a projected asset removes derived copies while keeping owner finance values', () => {
  for (const [section, ownerField] of [['vehicles', 'loan_balance'], ['real_estate', 'mortgage_balance']]) {
    const account = source(3, { group_name: 'Synthetic assets' });
    const projected = project(section, { [ownerField]: 'ZAR 321.00', owner_reference: 'Owner reference' }, account);
    // Both save and restore use this same sanitization boundary. Restore input
    // is serialized, so no client object identity or managed-key list is trusted.
    for (const input of [projected, JSON.parse(JSON.stringify(projected))]) {
      const clean = sanitizeHomebankEntry(input, visibility(account));
      assert.deepEqual(clean.fields, { [ownerField]: 'ZAR 321.00', owner_reference: 'Owner reference' });
      assert.equal(clean.notes, '');
      assert.equal(clean.homebank_managed_fields, undefined);
      assert.deepEqual(sanitizeHomebankEntry(clean, visibility(account)), clean);
      account.today = 564.12;
      const refreshed = projectHomebankEntry(clean, visibility(account));
      assert.equal(refreshed.fields.current_value, 'ZAR 564.12');
      assert.equal(refreshed.fields[ownerField], 'ZAR 321.00');
    }
  }
});

test('unlinked manual records are unchanged even when their fields resemble source projections', () => {
  const manual = { ...entry('vehicles', { current_value: 'Owner value', loan_balance: 'Owner loan',
    homebank_group: 'Owner label' }), homebank_account_id: null, notes: 'Owner notes' };
  assert.equal(projectHomebankEntry(manual, visibility(source(3))), manual);
  assert.equal(sanitizeHomebankEntry(manual, visibility(source(3))), manual);
});

test('startup cleanup uses each current owner account type and preserves finance details on hidden assets', () => {
  const db = cleanupDatabase();
  try {
    const fixtures = [
      { section: 'vehicles', account: source(3, { closed: true }),
        fields: { current_value: 'Old asset valuation', loan_balance: 'Owner vehicle loan' },
        expected: { loan_balance: 'Owner vehicle loan' } },
      { section: 'real_estate', account: source(3, { id: 18, excluded_from_summary: true }),
        fields: { current_value: 'Old property valuation', mortgage_balance: 'Owner mortgage' },
        expected: { mortgage_balance: 'Owner mortgage' } },
      { section: 'vehicles', account: source(5, { id: 19 }),
        fields: { current_value: 'Owner vehicle valuation', loan_balance: 'Old liability' },
        expected: { current_value: 'Owner vehicle valuation' } },
      { section: 'bank_accounts', account: source(6, { id: 20, bank_name: 'Synthetic bank' }),
        fields: { bank_name: 'Old bank', account_type: 'Other', homebank_group: 'Old group',
          balance_approx: 'Old ledger', nominee: 'Owner nominee' }, expected: { nominee: 'Owner nominee' } },
    ];
    db.prepare('INSERT INTO homebank_snapshots VALUES (?,?)')
      .run(41, encrypt(JSON.stringify({ accounts: fixtures.map(fixture => fixture.account) })));
    const insert = db.prepare(`INSERT INTO vault_entries VALUES (?,41,?,?,?,?, '2020-01-01','2020-02-02')`);
    for (const [index, fixture] of fixtures.entries()) {
      insert.run(index + 1, fixture.section, encrypt(JSON.stringify(fixture.fields)), encrypt('Old copied notes'), fixture.account.id);
    }
    const before = db.prepare('SELECT * FROM vault_entries ORDER BY id').all();
    assert.equal(clearStoredHomebankLedger(db), fixtures.length);
    const after = db.prepare('SELECT * FROM vault_entries ORDER BY id').all();
    for (const [index, fixture] of fixtures.entries()) {
      assert.deepEqual(JSON.parse(decrypt(after[index].fields_encrypted)), fixture.expected);
      assert.equal(after[index].notes_encrypted, null);
      for (const key of ['id', 'user_id', 'section', 'homebank_account_id', 'created_at', 'updated_at']) {
        assert.equal(after[index][key], before[index][key]);
      }
    }
    assert.equal(clearStoredHomebankLedger(db), 0);
    assert.deepEqual(db.prepare('SELECT * FROM vault_entries ORDER BY id').all(), after,
      'Repeated startup must preserve ciphertext and timestamps');
  } finally {
    db.close();
  }
});

test('startup cleanup retains owner balances when the saved account is absent or its snapshot is unavailable', () => {
  const cases = [
    { name: 'No saved snapshot' },
    { name: 'Empty snapshot', raw: null },
    { name: 'Malformed snapshot', raw: '{invalid JSON' },
    { name: 'Missing source account', raw: JSON.stringify({ accounts: [source(3, { id: 99 })] }) },
    { name: 'Invalid duplicated source account', raw: JSON.stringify({ accounts: [source(3), source(3)] }) },
    { name: 'Different owner snapshot', userId: 42, raw: JSON.stringify({ accounts: [source(3)] }) },
  ];
  for (const fixture of cases) {
    const db = cleanupDatabase();
    try {
      if (Object.hasOwn(fixture, 'raw')) {
        db.prepare('INSERT INTO homebank_snapshots VALUES (?,?)').run(fixture.userId || 41, encrypt(fixture.raw));
      }
      const fields = {
        vehicles: { current_value: 'Owner vehicle valuation', loan_balance: 'Owner vehicle loan', loan_provider: 'Owner lender' },
        real_estate: { current_value: 'Owner property valuation', mortgage_balance: 'Owner mortgage', mortgage_provider: 'Owner mortgage lender' },
      };
      const insert = db.prepare(`INSERT INTO vault_entries VALUES (?,41,?,?,?,?, '2020-01-01','2020-02-02')`);
      for (const [index, section] of ['vehicles', 'real_estate'].entries()) {
        insert.run(index + 1, section, encrypt(JSON.stringify(fields[section])), encrypt('Old copied notes'), 17 + index);
      }
      const before = db.prepare('SELECT * FROM vault_entries ORDER BY id').all();
      assert.equal(clearStoredHomebankLedger(db), 2, fixture.name);
      const after = db.prepare('SELECT * FROM vault_entries ORDER BY id').all();
      for (const [index, row] of after.entries()) {
        assert.deepEqual(JSON.parse(decrypt(row.fields_encrypted)), fields[row.section], fixture.name);
        assert.equal(row.fields_encrypted, before[index].fields_encrypted,
          `${fixture.name}: an unresolved account cannot authorize deleting an owner balance`);
        assert.equal(row.notes_encrypted, null);
      }
      assert.equal(clearStoredHomebankLedger(db), 0, fixture.name);
      assert.deepEqual(db.prepare('SELECT * FROM vault_entries ORDER BY id').all(), after);
    } finally {
      db.close();
    }
  }
});
