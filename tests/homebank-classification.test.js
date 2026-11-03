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
