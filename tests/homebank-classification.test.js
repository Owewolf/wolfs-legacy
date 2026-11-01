'use strict';

// Disposable, synthetic records only. Do not import server/db or access the
// application's database, HomeBank source directory or runtime environment.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
process.env.ENCRYPTION_KEY = 'bc'.repeat(32);
const { encrypt, decrypt } = require('../server/crypto');
const classification = require('../server/homebank-classification');
const { accountTypeId, classifyAccount } = classification;

test('HomeBank native account IDs take priority over display labels with a safe legacy fallback', () => {
  assert.equal(accountTypeId({ type_id: 6, type: 'Savings' }), 6);
  assert.equal(accountTypeId({ type: 'Credit card' }), 4);
  assert.equal(accountTypeId({ type: ' Uncategorised ' }), 0);
  assert.equal(accountTypeId({ type_id: 99, type: 'Checking' }), 6);
  assert.equal(accountTypeId({ type_id: 99, type: 'Unknown future type' }), null);
  assert.equal(accountTypeId(null), null);
});

test('explicit retirement annuity group supplies retirement purpose and product type', () => {
  const account = Object.freeze({ type_id: 7, type: 'Savings', group_name: 'Retirement Annuity' });
  assert.deepEqual(classifyAccount(account, 'investments'), {
    section: 'retirement', fields: { homebank_group: 'Retirement Annuity', type: 'Annuity' }
  });
  assert.deepEqual(account, { type_id: 7, type: 'Savings', group_name: 'Retirement Annuity' });
});

test('checking and cash source types replace stale banking subtype interpretations', () => {
  assert.deepEqual(classifyAccount(Object.freeze({ type_id: 6, type: 'Savings' }), 'investments'), {
    section: 'bank_accounts', fields: { homebank_group: '', account_type: 'Current / Checking' }
  });
  assert.deepEqual(classifyAccount(Object.freeze({ type_id: 2 }), 'retirement'), {
    section: 'bank_accounts', fields: { homebank_group: '', account_type: 'Cash' }
  });
});

test('credit cards and liabilities stay debts even when their group describes an asset', () => {
  assert.deepEqual(classifyAccount(Object.freeze({ type_id: 4, group_name: 'Vehicles', today: 50 }), 'vehicles'), {
    section: 'debts', fields: { homebank_group: 'Vehicles', type: 'Credit Card' }
  });
  assert.deepEqual(classifyAccount(Object.freeze({ type_id: 5, group_name: 'Real Estate', today: -50 }), 'real_estate'), {
    section: 'debts', fields: { homebank_group: 'Real Estate' }
  });
});

test('generic savings preserves deliberately classified investments and retirement', () => {
  for (const section of ['investments', 'retirement']) {
    assert.deepEqual(classifyAccount({ type_id: 7, group_name: 'Personal' }, section), {
      section, fields: { homebank_group: 'Personal' }
    });
  }
  assert.deepEqual(classifyAccount({ type_id: 7 }, 'bank_accounts'), {
    section: 'bank_accounts', fields: { homebank_group: '', account_type: 'Savings' }
  });
});

test('asset balance signs and transaction categories do not invent purpose, ownership or loans', () => {
  for (const today of [-500, 0, 500]) {
    const account = Object.freeze({ type_id: 3, today, group_name: 'Family Trust',
      transactions: Object.freeze([Object.freeze({ category_id: 7, memo: 'Mortgage payment' })]) });
    const result = classifyAccount(account, 'vehicles');
    assert.deepEqual(result, { section: 'vehicles', fields: { homebank_group: 'Family Trust' } });
    assert.equal(result.fields.loan_balance, undefined);
    assert.equal(result.fields.ownership, undefined);
    assert.equal(result.fields.type, undefined);
  }
});

test('a source without an allocation or recognized group has no inferred product type', () => {
  assert.deepEqual(classifyAccount({ type_id: 3, group_name: 'Personal' }), { section: undefined, fields: {} });
  assert.deepEqual(classifyAccount({ type_id: 0 }), { section: undefined, fields: {} });
});

test('explicit institution allocations match asset institutions with presentation differences only', () => {
  const options = Object.freeze({ institutionAllocations: Object.freeze([
    Object.freeze({ institution: " Example's   Fleet ", section: 'vehicles' }),
    Object.freeze({ institution: 'Example Property Holdings', section: 'real_estate' })
  ]) });
  for (const bank_name of ["EXAMPLE'S FLEET", ' Example’s\tFleet ', 'Ｅｘａｍｐｌｅʼｓ　Ｆｌｅｅｔ']) {
    const source = Object.freeze({ type_id: 3, bank_name, group_name: 'Personal', today: -50 });
    assert.deepEqual(classifyAccount(source, 'investments', options), {
      section: 'vehicles', fields: { homebank_group: 'Personal' }
    });
  }
  assert.equal(classifyAccount({ type_id: 3, bank_name: 'EXAMPLE PROPERTY HOLDINGS' },
    'investments', options).section, 'real_estate');
  for (const bank_name of ["Example's Fleet Loans", "New Example's Fleet", "Example's-Fleet", null, '']) {
    assert.equal(classifyAccount({ type_id: 3, bank_name, name: "Example's Fleet" },
      'investments', options).section, 'investments');
  }
  assert.equal(classifyAccount({ type_id: 3, institution: "Example's Fleet" },
    'investments', options).section, 'investments', 'Only the parsed source institution can match');
  assert.equal(classifyAccount({ type_id: 3, bank_name: "Example's Fleet" },
    'investments').section, 'investments', 'An institution name has no inferred purpose without a rule');
});

test('owner institution allocations override groups for assets without converting debts or bank ledgers', () => {
  const options = { institutionAllocations: [{ institution: 'Example Fleet', section: 'vehicles' }] };
  assert.deepEqual(classifyAccount({ type_id: 3, bank_name: 'Example Fleet',
    group_name: 'Retirement Annuity' }, 'investments', options), {
    section: 'vehicles', fields: { homebank_group: 'Retirement Annuity' }
  });
  for (const [type_id, existing, expected] of [[0, 'investments', 'investments'],
    [1, 'bank_accounts', 'bank_accounts'], [2, 'investments', 'bank_accounts'],
    [4, 'vehicles', 'debts'], [5, 'vehicles', 'debts'],
    [6, 'investments', 'bank_accounts'], [7, 'bank_accounts', 'bank_accounts'],
    [99, 'investments', 'investments']]) {
    assert.equal(classifyAccount({ type_id, bank_name: 'Example Fleet' },
      existing, options).section, expected);
  }
  for (const type_id of [4, 5]) {
    assert.equal(classifyAccount({ type_id, bank_name: 'Example Fleet', group_name: 'Vehicles' },
      'vehicles', options).section, 'debts');
  }
});

test('invalid or conflicting institution rules cannot guess a purpose or depend on rule order', () => {
  const source = { type_id: 3, bank_name: 'Example Fleet', group_name: 'Personal' };
  const invalid = [null, false, {}, 'vehicles', [], { section: 'vehicles' },
    { institution: {}, section: 'vehicles' }, { institution: '', section: 'vehicles' },
    { institution: 'Example Fleet', section: 'retirement' },
    { institution: 'Example Fleet', section: 'Vehicles' }];
  for (const institutionAllocations of [undefined, null, false, {}, 'vehicles', ...invalid.map(rule => [rule])]) {
    assert.equal(classifyAccount(source, 'investments', { institutionAllocations }).section, 'investments');
  }
  assert.equal(classifyAccount(source, 'investments', null).section, 'investments');
  const vehicle = { institution: 'Example Fleet', section: 'vehicles' };
  const property = { institution: ' EXAMPLE\tFLEET ', section: 'real_estate' };
  for (const institutionAllocations of [[vehicle, property], [property, vehicle], [vehicle, vehicle, property]]) {
    assert.equal(classifyAccount(source, 'investments', { institutionAllocations }).section, 'investments');
  }
  assert.equal(classifyAccount(source, 'investments',
    { institutionAllocations: [...invalid, vehicle, { ...vehicle }] }).section, 'vehicles',
  'Malformed rules are ignored and duplicate equivalent allocations remain valid');
});

test('stale entry alignment uses the same institution allocation as reconciliation', () => {
  const source = { id: 101, type_id: 3, bank_name: 'Example Fleet', group_name: 'Retirement Annuity' };
  const entry = { id: 7, homebank_account_id: 101, section: 'investments',
    fields: { value_approx: 'Stale source valuation', loan_balance: 'Owner vehicle loan',
      registration: 'EXAMPLE-123' } };
  const visibility = {
    accountForEntry: () => source,
    classificationOptions: { institutionAllocations: [{ institution: 'Example Fleet', section: 'vehicles' }] }
  };
  const aligned = classification.alignHomebankEntry(entry, visibility);
  assert.equal(aligned.section, 'vehicles');
  assert.deepEqual(aligned.fields, { loan_balance: 'Owner vehicle loan', registration: 'EXAMPLE-123' });
  assert.equal(entry.section, 'investments', 'Aligning a view must not mutate its original input');
});

function fixture(t) {
  const db = new Database(':memory:');
  t.after(() => db.close());
  db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL);
    INSERT INTO users VALUES (42,'fixture-owner@example.test'),(43,'fixture-other@example.test');
    CREATE TABLE vault_entries (
      id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, section TEXT NOT NULL,
      title TEXT NOT NULL, fields_encrypted TEXT NOT NULL, notes_encrypted TEXT,
      homebank_account_id INTEGER, created_at TEXT, updated_at TEXT
    );
    CREATE TABLE document_associations (document_id TEXT, entry_id INTEGER);`);
  function add(id, section, fields, accountId, userId = 42) {
    db.prepare(`INSERT INTO vault_entries
      (id,user_id,section,title,fields_encrypted,notes_encrypted,homebank_account_id,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,'2020-01-01','2020-02-02')`)
      .run(id, userId, section, `Fixture owner title ${id}`, encrypt(JSON.stringify(fields)),
        encrypt(`Fixture owner notes ${id}`), accountId);
    db.prepare('INSERT INTO document_associations VALUES (?,?)').run(`fixture-document-${id}`, id);
  }
  function rows() { return db.prepare('SELECT * FROM vault_entries ORDER BY id').all(); }
  return { db, add, rows };
}

const options = Object.freeze({ ownerEmail: 'fixture-owner@example.test' });
const sourceAccount = (id, values) => Object.freeze({ id, closed: false, excluded_from_summary: false, ...values });
const snapshot = accounts => Object.freeze({ snapshot_schema_version: 3, accounts: Object.freeze(accounts) });

test('reconciliation moves linked classifications while retaining owner details, identity and documents', t => {
  const { db, add, rows } = fixture(t);
  add(1, 'bank_accounts', { bank_name: 'Fixture owner institution', account_number: '000123',
    online_url: 'https://fixture.example.test/bank', account_type: 'Fixed Deposit',
    nominee: 'Fixture nominee', owner_reference: 'Keep this custom field' }, 101);
  add(2, 'investments', { institution: 'Fixture investment institution', type: 'Bonds',
    login_url: 'https://fixture.example.test/investment', nominee: 'Fixture nominee' }, 102);
  add(3, 'bank_accounts', { bank_name: 'Fixture card issuer', account_number: '000456' }, 103);
  const before = rows();
  const documentsBefore = db.prepare('SELECT * FROM document_associations').all();
  const source = snapshot([
    sourceAccount(101, { type_id: 7, group_name: 'Retirement Annuity' }),
    sourceAccount(102, { type_id: 3, group_name: 'Retirement Annuity' }),
    sourceAccount(103, { type_id: 4, group_name: 'Personal' })
  ]);
  const result = classification.reconcileHomebankClassifications(db, 42, source, options);
  assert.equal(result.changed, 3);
  const after = rows();
  const first = JSON.parse(decrypt(after[0].fields_encrypted));
  assert.equal(after[0].section, 'retirement');
  assert.equal(first.provider, 'Fixture owner institution');
  assert.equal(first.account_number, '000123');
  assert.equal(first.login_url, 'https://fixture.example.test/bank');
  assert.equal(first.investment_type, 'Fixed Deposit');
  assert.equal(first.beneficiary, 'Fixture nominee');
  assert.equal(first.nominee, undefined, 'Nominee belongs in the retirement beneficiary control');
  assert.equal(first.owner_reference, 'Keep this custom field');
  const second = JSON.parse(decrypt(after[1].fields_encrypted));
  assert.equal(after[1].section, 'retirement');
  assert.equal(second.provider, 'Fixture investment institution');
  assert.equal(second.investment_type, 'Bonds');
  assert.equal(second.login_url, 'https://fixture.example.test/investment');
  const third = JSON.parse(decrypt(after[2].fields_encrypted));
  assert.equal(after[2].section, 'debts');
  assert.equal(third.creditor, 'Fixture card issuer');
  assert.equal(third.account_number, '000456');
  for (const row of after) {
    const previous = before.find(item => item.id === row.id);
    for (const key of ['id', 'user_id', 'title', 'homebank_account_id', 'created_at', 'notes_encrypted']) {
      assert.equal(row[key], previous[key], `${key} must be retained`);
    }
    assert.equal(JSON.parse(decrypt(row.fields_encrypted)).homebank_group, undefined,
      'Source classifications are projected rather than persisted as copied metadata');
  }
  assert.deepEqual(db.prepare('SELECT * FROM document_associations').all(), documentsBefore);
  const repeat = classification.reconcileHomebankClassifications(db, 42, source, options);
  assert.equal(repeat.changed, 0);
  assert.deepEqual(rows(), after, 'Repeated sync must not rewrite ciphertext or timestamps');
});

test('reconciliation never changes manual records, another owner or missing source records', t => {
  const { db, add, rows } = fixture(t);
  add(1, 'investments', { institution: 'Manual owner institution', type: 'Bonds' }, null);
  add(2, 'investments', { institution: 'Other owner institution', type: 'Bonds' }, 101, 43);
  add(3, 'investments', { institution: 'Missing source institution', type: 'Bonds' }, 999);
  const before = rows();
  const source = snapshot([sourceAccount(101, { type_id: 7, group_name: 'Retirement Annuity' })]);
  assert.equal(classification.reconcileHomebankClassifications(db, 42, source, options).changed, 0);
  assert.deepEqual(rows(), before);
  assert.equal(classification.reconcileHomebankClassifications(db, 43, source, options).changed, 0);
  assert.deepEqual(rows(), before);
  assert.equal(rows().length, 3, 'A source account without a linked record must not be recreated');
});

test('unconfigured owner and old or malformed snapshots cannot reclassify persisted records', t => {
  const { db, add, rows } = fixture(t);
  add(1, 'investments', { institution: 'Fixture institution', type: 'Bonds' }, 101);
  const before = rows();
  const accounts = [sourceAccount(101, { type_id: 7, group_name: 'Retirement Annuity' })];
  for (const invalid of [null, { accounts }, { snapshot_schema_version: 2, accounts },
    { snapshot_schema_version: 3, accounts: null }]) {
    assert.equal(classification.reconcileHomebankClassifications(db, 42, invalid, options).changed, 0);
    assert.deepEqual(rows(), before);
  }
  for (const ownerEmail of ['', 'missing@example.test']) {
    assert.equal(classification.reconcileHomebankClassifications(db, 42, snapshot(accounts), { ownerEmail }).changed, 0);
    assert.deepEqual(rows(), before);
  }
});

test('invalid stored field payloads remain recoverable during classification reconciliation', t => {
  const { db, add, rows } = fixture(t);
  add(1, 'investments', { institution: 'Fixture institution' }, 101);
  db.prepare('UPDATE vault_entries SET fields_encrypted=? WHERE id=1').run(encrypt('{invalid JSON'));
  const before = rows();
  const result = classification.reconcileHomebankClassifications(db, 42,
    snapshot([sourceAccount(101, { type_id: 7, group_name: 'Retirement Annuity' })]), options);
  assert.equal(result.changed, 0);
  assert.ok(result.skipped >= 1);
  assert.deepEqual(rows(), before);
});

const namedAccount = (id, values) => sourceAccount(id, { name: `Synthetic account ${id}`, ...values });

test('account reconciliation creates active source identities once with encrypted empty owner fields', t => {
  const { db, rows } = fixture(t);
  const source = snapshot([
    namedAccount(101, { type_id: 6, bank_name: 'Source institution', account_number: 'SOURCE123', today: 950 }),
    namedAccount(102, { type_id: 7, group_name: 'Retirement Annuity' }),
    namedAccount(103, { type_id: 4, group_name: 'Vehicles' }),
    namedAccount(104, { type_id: 3, group_name: 'Real Estate' }),
    namedAccount(105, { type_id: 3, group_name: 'Vehicles' }),
    namedAccount(106, { type_id: 3, group_name: 'Investments' }),
    namedAccount(107, { type_id: 5 }),
    namedAccount(108, { type_id: 2 }),
    namedAccount(109, { type_id: 1, closed: true }),
    namedAccount(110, { type_id: 1, excluded_from_summary: true })
  ]);
  assert.deepEqual(classification.reconcileHomebankAccounts(db, 42, source, options),
    { created: 8, changed: 0, skipped: 0 });
  const added = rows();
  assert.deepEqual(added.map(row => [row.homebank_account_id, row.section]), [
    [101, 'bank_accounts'], [102, 'retirement'], [103, 'debts'], [104, 'real_estate'],
    [105, 'vehicles'], [106, 'investments'], [107, 'debts'], [108, 'bank_accounts']
  ]);
  for (const row of added) {
    assert.equal(row.user_id, 42);
    assert.equal(row.title, `Synthetic account ${row.homebank_account_id}`);
    assert.deepEqual(JSON.parse(decrypt(row.fields_encrypted)), {});
    assert.notEqual(row.fields_encrypted, '{}');
    assert.equal(row.notes_encrypted, null);
  }
  assert.deepEqual(classification.reconcileHomebankAccounts(db, 42, source, options),
    { created: 0, changed: 0, skipped: 0 });
  assert.deepEqual(rows(), added, 'Repeated reconciliation does not rewrite identity, ciphertext or timestamps');
});

test('new unspecified assets use generic allocation while names and balance signs never classify them', t => {
  const { db, rows } = fixture(t);
  const source = snapshot([
    namedAccount(101, { type_id: 3, name: 'Synthetic car mortgage', group_name: 'Personal', today: -100 }),
    namedAccount(102, { type_id: 0, name: 'Synthetic pension', today: 200 }),
    namedAccount(103, { type_id: 99, type: 'Future source type', today: -500 }),
    namedAccount(104, { type_id: 1, name: '   ' })
  ]);
  assert.equal(classification.reconcileHomebankAccounts(db, 42, source, options).created, 4);
  assert.deepEqual(rows().map(row => row.section), ['investments', 'bank_accounts', 'bank_accounts', 'bank_accounts']);
  assert.equal(rows()[3].title, 'HomeBank account 104');
  for (const row of rows()) assert.deepEqual(JSON.parse(decrypt(row.fields_encrypted)), {});
});

test('account reconciliation preserves manual records, existing links, documents and other owners', t => {
  const { db, add, rows } = fixture(t);
  add(1, 'bank_accounts', { owner_reference: 'Existing owner detail' }, 101);
  add(2, 'retirement', { provider: 'Manual provider' }, null);
  add(3, 'bank_accounts', { owner_reference: 'Other owner detail' }, 102, 43);
  const original = rows();
  const documents = db.prepare('SELECT * FROM document_associations').all();
  const source = snapshot([namedAccount(101, { type_id: 1 }), namedAccount(102, { type_id: 1 })]);
  assert.equal(classification.reconcileHomebankAccounts(db, 42, source, options).created, 1);
  assert.deepEqual(rows().slice(0, 3), original);
  assert.deepEqual(db.prepare('SELECT * FROM document_associations').all(), documents);
  assert.equal(rows()[3].user_id, 42);
  assert.equal(rows()[3].homebank_account_id, 102);
  const after = rows();
  assert.deepEqual(classification.reconcileHomebankAccounts(db, 43, source, options),
    { created: 0, changed: 0, skipped: 0 });
  for (const ownerEmail of ['', 'missing@example.test']) {
    assert.deepEqual(classification.reconcileHomebankAccounts(db, 42, source, { ownerEmail }),
      { created: 0, changed: 0, skipped: 0 });
  }
  assert.deepEqual(rows(), after);
});

test('invalid account snapshots never partially create or reclassify entries', t => {
  const { db, add, rows } = fixture(t);
  add(1, 'bank_accounts', { owner_reference: 'Keep owner detail' }, 101);
  const original = rows();
  const valid = namedAccount(101, { type_id: 7, group_name: 'Retirement Annuity' });
  const badAccounts = [
    namedAccount(102, { id: 101 }), namedAccount(102, { closed: 'false' }),
    namedAccount(102, { excluded_from_summary: 0 }), namedAccount(102, { name: null }),
    namedAccount(102, { group_name: {} }), namedAccount(102, { type_id: -1 }),
    namedAccount(102, { type: {} }), null
  ];
  for (const bad of badAccounts) {
    assert.throws(() => classification.reconcileHomebankAccounts(db, 42, snapshot([valid, bad]), options),
      /Invalid HomeBank account snapshot/);
    assert.deepEqual(rows(), original);
  }
  for (const invalid of [null, { accounts: [] }, { snapshot_schema_version: 2, accounts: [] }]) {
    assert.throws(() => classification.reconcileHomebankAccounts(db, 42, invalid, options), /Invalid HomeBank/);
    assert.deepEqual(rows(), original);
  }
});

test('an account creation failure rolls back linked reclassification and all new records', t => {
  const { db, add, rows } = fixture(t);
  add(1, 'bank_accounts', { owner_reference: 'Keep owner detail' }, 101);
  const original = rows();
  db.exec(`CREATE TRIGGER reject_synthetic_account BEFORE INSERT ON vault_entries
    WHEN new.homebank_account_id = 103 BEGIN SELECT RAISE(ABORT,'Synthetic insert failure'); END;`);
  const source = snapshot([
    namedAccount(101, { type_id: 7, group_name: 'Retirement Annuity' }),
    namedAccount(102, { type_id: 1 }), namedAccount(103, { type_id: 1 })
  ]);
  assert.throws(() => classification.reconcileHomebankAccounts(db, 42, source, options), /Synthetic insert failure/);
  assert.deepEqual(rows(), original);
});

test('a dry run reports missing accounts and classifications without modifying the database', t => {
  const { db, add, rows } = fixture(t);
  add(1, 'bank_accounts', {}, 101);
  const original = rows();
  const result = classification.reconcileHomebankAccounts(db, 42,
    snapshot([namedAccount(101, { type_id: 7, group_name: 'Retirement Annuity' }), namedAccount(102, { type_id: 1 })]),
    { ...options, dryRun: true });
  assert.deepEqual(result, { created: 1, changed: 1, skipped: 0 });
  assert.deepEqual(rows(), original);
});

test('institution allocations reconcile existing and new assets while preserving unrelated owner records', t => {
  const { db, add, rows } = fixture(t);
  add(1, 'investments', { registration: 'EXAMPLE-123', loan_balance: 'Owner loan balance' }, 101);
  add(2, 'investments', { owner_reference: 'Other owner detail' }, 101, 43);
  add(3, 'investments', { owner_reference: 'Manual owner detail' }, null);
  const before = rows();
  const documents = db.prepare('SELECT * FROM document_associations').all();
  const allocations = { ...options, institutionAllocations: [
    { institution: 'Example Fleet', section: 'vehicles' },
    { institution: 'Example Properties', section: 'real_estate' }
  ] };
  const source = snapshot([
    namedAccount(101, { type_id: 3, bank_name: 'EXAMPLE FLEET', group_name: 'Retirement Annuity' }),
    namedAccount(102, { type_id: 3, bank_name: 'Example Properties' }),
    namedAccount(103, { type_id: 3, bank_name: 'Example Fleet' }),
    namedAccount(104, { type_id: 3, bank_name: 'Example Fleet', closed: true }),
    namedAccount(105, { type_id: 3, bank_name: 'Example Fleet', excluded_from_summary: true }),
    namedAccount(106, { type_id: 3, bank_name: 'Unrelated institution' })
  ]);
  assert.deepEqual(classification.reconcileHomebankAccounts(db, 42, source, allocations),
    { created: 3, changed: 1, skipped: 0 });
  const after = rows();
  assert.deepEqual(after[0], { ...before[0], section: 'vehicles' },
    'Changing the purpose preserves the existing identity, encrypted owner fields and timestamps');
  assert.deepEqual(after.slice(1, 3), before.slice(1, 3));
  assert.deepEqual(after.slice(3).map(row => [row.homebank_account_id, row.section]),
    [[102, 'real_estate'], [103, 'vehicles'], [106, 'investments']]);
  assert.deepEqual(db.prepare('SELECT * FROM document_associations').all(), documents);
  assert.deepEqual(classification.reconcileHomebankAccounts(db, 42, source, allocations),
    { created: 0, changed: 0, skipped: 0 });
  assert.deepEqual(rows(), after, 'A repeated connected sync must not rewrite corrected owner records');
  assert.deepEqual(classification.reconcileHomebankAccounts(db, 43, source, allocations),
    { created: 0, changed: 0, skipped: 0 });
  assert.deepEqual(rows(), after, 'Institution rules do not authorize another user to receive source accounts');
});
