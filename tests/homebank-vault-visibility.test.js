'use strict';

// All records, credentials, snapshots, and documents below are synthetic. The
// database constructor is redirected before server/db is loaded, so these tests
// cannot open the application's on-disk vault.
const { before, beforeEach, after, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { once } = require('node:events');
const Database = require('better-sqlite3');
const express = require('express');
const jwt = require('jsonwebtoken');

process.env.ENCRYPTION_KEY = 'ab'.repeat(32);
process.env.JWT_SECRET = 'fixture-only-homebank-visibility-secret';
process.env.HOMEBANK_OWNER_EMAIL = 'homebank-fixture@example.test';

const OWNER_ID = 901;
const OTHER_ID = 902;
const BENEFICIARY_TOKEN = 'fixture-only-beneficiary-token';
const SOURCE_ACCOUNTS = [
  { id: 101, name: 'Fixture current', closed: false, excluded_from_summary: false },
  { id: 102, name: 'Fixture closed', closed: true, excluded_from_summary: false },
  { id: 103, name: 'Fixture excluded', closed: false, excluded_from_summary: true },
  { id: 105, name: 'Fixture property', closed: false, excluded_from_summary: false },
  { id: 106, name: 'Fixture savings', closed: false, excluded_from_summary: false }
];

let db;
let server;
let baseUrl;
let visibility;
let crypto;
let fixture;
let syncCalls = [];
let sourceUpdateOnSync = null;

function provenance(id) {
  return `Imported from HomeBank on 2026-01-01.\nSource file: fixture.xhb\nHomeBank account ID: ${id}`;
}

function setSnapshot(accounts = SOURCE_ACCOUNTS, { lastError = null, rawSnapshot, exportedDate = '2026-10-25' } = {}) {
  const snapshot = rawSnapshot === undefined ? { accounts, exported_date: exportedDate, counts: { all: accounts.length } } : rawSnapshot;
  db.prepare(`INSERT INTO homebank_snapshots
    (user_id, config_encrypted, snapshot_encrypted, last_error, source_file)
    VALUES (?, ?, ?, ?, 'fixture.xhb')
    ON CONFLICT(user_id) DO UPDATE SET snapshot_encrypted=excluded.snapshot_encrypted,
      last_error=excluded.last_error`)
    .run(OWNER_ID, crypto.encrypt(JSON.stringify({ auto: false, directory: '/fixture/unused' })),
      snapshot === null ? null : crypto.encrypt(JSON.stringify(snapshot)), lastError);
}

function addEntry({ title, accountId = null, section = 'bank_accounts', notes = '', userId = OWNER_ID,
  fields = { institution: 'Fixture' } }) {
  return Number(db.prepare(`INSERT INTO vault_entries
    (user_id, section, title, fields_encrypted, notes_encrypted, homebank_account_id)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .run(userId, section, title, crypto.encrypt(JSON.stringify(fields)),
      notes ? crypto.encrypt(notes) : null, accountId).lastInsertRowid);
}

function ids(entries) {
  return entries.map(e => e.id).sort((a, b) => a - b);
}

function visibleIds() {
  return [fixture.manual, fixture.current, fixture.property, fixture.savings].sort((a, b) => a - b);
}

async function request(route, { method = 'GET', body, userId = OWNER_ID, status = 200 } = {}) {
  const token = jwt.sign({ id: userId }, process.env.JWT_SECRET, { expiresIn: '5m' });
  const response = await fetch(baseUrl + route, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const json = await response.json();
  assert.equal(response.status, status, `${method} ${route}: ${JSON.stringify(json)}`);
  return json;
}

before(async () => {
  db = new Database(':memory:');
  // Exercise the upgrade path used by existing vaults, not only fresh installs.
  db.exec(`CREATE TABLE vault_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
    section TEXT NOT NULL, title TEXT NOT NULL, fields_encrypted TEXT NOT NULL,
    notes_encrypted TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);
  const databaseModule = require.cache[require.resolve('better-sqlite3')];
  const originalConstructor = databaseModule.exports;
  databaseModule.exports = function FixtureDatabase(filename) {
    assert.equal(filename, path.resolve(__dirname, '../data/vault.db'));
    return db;
  };
  try {
    assert.equal(require('../server/db').getDb(), db);
  } finally {
    databaseModule.exports = originalConstructor;
  }
  assert.ok(db.prepare('PRAGMA table_info(vault_entries)').all().some(c => c.name === 'homebank_account_id'));

  crypto = require('../server/crypto');
  visibility = require('../server/vault-visibility');
  const insertUser = db.prepare('INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)');
  insertUser.run(OWNER_ID, process.env.HOMEBANK_OWNER_EMAIL, 'Fixture owner', 'fixture-password-hash');
  insertUser.run(OTHER_ID, 'other-fixture@example.test', 'Other fixture owner', 'fixture-password-hash');

  // Vault reads must request fresh source data. Stub the service before routes
  // load so fixture tests can exercise that request path without reading any
  // real HomeBank directory, credentials, or bank file.
  require('../server/homebank-service').syncUser = async userId => {
    syncCalls.push(userId);
    if (sourceUpdateOnSync) {
      const update = sourceUpdateOnSync;
      sourceUpdateOnSync = null;
      update();
    }
  };

  const app = express();
  app.use(express.json());
  app.use('/api/vault', require('../server/routes/vault'));
  app.use('/api/beneficiaries', require('../server/routes/beneficiaries'));
  app.use('/api/documents', require('../server/routes/documents'));
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(() => {
  syncCalls = [];
  sourceUpdateOnSync = null;
  db.exec(`DELETE FROM document_associations; DELETE FROM managed_documents;
    DELETE FROM vault_entries; DELETE FROM homebank_snapshots; DELETE FROM beneficiaries;
    DELETE FROM audit_log;`);
  setSnapshot();
  fixture = {
    manual: addEntry({ title: 'Fixture manual account' }),
    current: addEntry({ title: 'Fixture current account', accountId: 101, notes: provenance(101) }),
    closed: addEntry({ title: 'Fixture closed debt', accountId: 102, section: 'debts', notes: provenance(102) }),
    excluded: addEntry({ title: 'Fixture excluded investment', accountId: 103, section: 'investments', notes: provenance(103) }),
    missing: addEntry({ title: 'Fixture removed vehicle', accountId: 104, section: 'vehicles', notes: provenance(104) }),
    property: addEntry({ title: 'Fixture property', accountId: 105, section: 'real_estate', notes: provenance(105) }),
    savings: addEntry({ title: 'Fixture savings account', accountId: 106, notes: provenance(106) })
  };
  db.prepare(`INSERT INTO beneficiaries
    (user_id, name, access_token, access_granted, token_expires_at) VALUES (?, ?, ?, 1, ?)`)
    .run(OWNER_ID, 'Fixture beneficiary', crypto.hashToken(BENEFICIARY_TOKEN), '2099-01-01T00:00:00.000Z');
});

after(async () => {
  if (server) await new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  if (db?.open) db.close();
});

test('pagination, totals, section counts, and search all use the same account filters', async () => {
  const first = await request('/api/vault/entries?limit=2&page=1');
  const second = await request('/api/vault/entries?limit=2&page=2');
  for (const page of [first, second]) {
    assert.equal(page.total, 4);
    assert.equal(page.pages, 2);
    assert.equal(page.entries.length, 2);
  }
  assert.deepEqual(ids([...first.entries, ...second.entries]), visibleIds());

  const bank = await request('/api/vault/entries?section=bank_accounts&limit=2&page=2');
  assert.equal(bank.total, 3);
  assert.equal(bank.pages, 2);
  assert.equal(bank.entries.length, 1);
  assert.deepEqual(await request('/api/vault/summary'), [
    { section: 'bank_accounts', count: 3 }, { section: 'real_estate', count: 1 }
  ]);
  assert.deepEqual(ids(await request('/api/vault/search?q=Fixture')), visibleIds());
  const emptyPage = await request('/api/vault/entries?page=10&limit=2');
  assert.equal(emptyPage.total, 4);
  assert.deepEqual(emptyPage.entries, []);
});

test('detail, export, backup, and beneficiary access exclude closed, excluded, and removed accounts', async () => {
  for (const id of [fixture.closed, fixture.excluded, fixture.missing]) {
    await request(`/api/vault/entries/${id}`, { status: 404 });
  }
  assert.equal((await request(`/api/vault/entries/${fixture.current}`)).id, fixture.current);
  assert.deepEqual(ids((await request('/api/vault/export')).entries), visibleIds());
  const backup = await request('/api/vault/backup');
  assert.deepEqual(backup.entries.map(e => e.title).sort(), [
    'Fixture manual account', 'Fixture current account', 'Fixture property', 'Fixture savings account'
  ].sort());
  assert.equal(backup.entries.find(e => e.title === 'Fixture current account').homebank_account_id, 101);
  const granted = await request('/api/beneficiaries/access', { method: 'POST', body: { accessToken: BENEFICIARY_TOKEN } });
  assert.equal(granted.status, 'granted');
  assert.deepEqual(ids(granted.entries), visibleIds());
});

test('new valid snapshots immediately change visibility and source deletion hides the linked record', async () => {
  assert.equal((await request('/api/vault/entries')).total, 4);
  setSnapshot(SOURCE_ACCOUNTS.filter(a => a.id !== 101).map(a =>
    a.id === 106 ? { ...a, excluded_from_summary: true } : a));
  assert.deepEqual(ids((await request('/api/vault/entries')).entries), [fixture.manual, fixture.property]);
  await request(`/api/vault/entries/${fixture.current}`, { status: 404 });
  await request(`/api/vault/entries/${fixture.savings}`, { status: 404 });
  assert.ok(db.prepare('SELECT id FROM vault_entries WHERE id=?').get(fixture.current), 'Filtering must preserve the stored entry');

  setSnapshot(SOURCE_ACCOUNTS.map(a => a.id === 101 ? { ...a, name: 'Fixture renamed at source' } : a));
  assert.deepEqual(ids((await request('/api/vault/entries')).entries), visibleIds());
});

test('a sync error retains the last validated snapshot; unavailable or invalid snapshots hide linked rows', async () => {
  setSnapshot(SOURCE_ACCOUNTS, { lastError: 'Fixture source is temporarily unavailable' });
  assert.deepEqual(ids((await request('/api/vault/entries')).entries), visibleIds());
  for (const rawSnapshot of [null, {}, { accounts: 'invalid' }, { accounts: [{ id: 101 }] },
    { accounts: [...SOURCE_ACCOUNTS, SOURCE_ACCOUNTS[0]] },
    { accounts: [{ ...SOURCE_ACCOUNTS[0], closed: 'false' }] }]) {
    setSnapshot([], { rawSnapshot });
    assert.deepEqual(ids((await request('/api/vault/entries')).entries), [fixture.manual]);
  }
});

test('metadata survives title and notes edits and cannot be removed through an ordinary update', async () => {
  await request(`/api/vault/entries/${fixture.current}`, {
    method: 'PUT', body: { section: 'bank_accounts', title: 'Fixture renamed by owner',
      fields: { institution: 'Fixture edited' }, notes: 'Fixture notes replaced', homebank_account_id: null }
  });
  assert.equal(db.prepare('SELECT homebank_account_id FROM vault_entries WHERE id=?').get(fixture.current).homebank_account_id, 101);
  setSnapshot(SOURCE_ACCOUNTS.filter(a => a.id !== 101));
  await request(`/api/vault/entries/${fixture.current}`, { status: 404 });
});

test('backup and overwrite restore retain the link even without original import notes', async () => {
  const backup = await request('/api/vault/backup');
  const restored = backup.entries.find(e => e.homebank_account_id === 101);
  restored.notes = 'Fixture notes replaced before backup';
  await request(`/api/vault/entries/${fixture.current}`, { method: 'DELETE' });
  const response = await request('/api/vault/restore', {
    method: 'POST', body: { mode: 'overwrite', entries: [restored] }
  });
  assert.equal(response.added, 1);
  const row = db.prepare('SELECT * FROM vault_entries WHERE user_id=? AND title=?').get(OWNER_ID, restored.title);
  assert.equal(row.homebank_account_id, 101);
  // An older backup lacking metadata also retains an existing durable link.
  delete restored.homebank_account_id;
  await request('/api/vault/restore', { method: 'POST', body: { mode: 'overwrite', entries: [restored] } });
  const overwritten = db.prepare('SELECT * FROM vault_entries WHERE user_id=? AND title=?').get(OWNER_ID, restored.title);
  assert.equal(overwritten.homebank_account_id, 101);
  setSnapshot(SOURCE_ACCOUNTS.filter(a => a.id !== 101));
  await request(`/api/vault/entries/${overwritten.id}`, { status: 404 });
});

test('a deleted vault account is not recreated when the source snapshot is refreshed', async () => {
  await request(`/api/vault/entries/${fixture.current}`, { method: 'DELETE' });
  setSnapshot();
  await request('/api/vault/entries');
  visibility.backfillHomeBankLinks(db);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vault_entries WHERE homebank_account_id=101').get().n, 0);
  await request(`/api/vault/entries/${fixture.current}`, { status: 404 });
});

test('migration links only strong import provenance belonging to the configured owner', () => {
  const imported = addEntry({ title: 'Fixture historical import', notes: provenance(101) });
  const freeText = addEntry({ title: 'Fixture manual note', notes: 'HomeBank account ID: 104' });
  const duplicateId = addEntry({ title: 'Fixture ambiguous import', notes: provenance(104) + '\nHomeBank account ID: 101' });
  const otherOwner = addEntry({ title: 'Fixture other owner import', notes: provenance(104), userId: OTHER_ID });
  const before = db.prepare('SELECT COUNT(*) AS n FROM vault_entries').get().n;
  visibility.backfillHomeBankLinks(db);
  visibility.backfillHomeBankLinks(db);
  const link = id => db.prepare('SELECT homebank_account_id FROM vault_entries WHERE id=?').get(id).homebank_account_id;
  assert.equal(link(imported), 101);
  for (const id of [freeText, duplicateId, otherOwner]) assert.equal(link(id), null);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vault_entries').get().n, before);
});

test('other owners keep their manual records and cannot read the configured owner records', async () => {
  const manual = addEntry({ title: 'Fixture other owner manual', userId: OTHER_ID });
  const listed = await request('/api/vault/entries', { userId: OTHER_ID });
  assert.deepEqual(ids(listed.entries), [manual]);
  await request(`/api/vault/entries/${fixture.current}`, { userId: OTHER_ID, status: 404 });
});

test('document entry lists, counts, and beneficiary content obey account visibility', async () => {
  const docId = '00000000-0000-4000-8000-000000000001';
  db.prepare(`INSERT INTO managed_documents
    (id,user_id,original_name_encrypted,display_name_encrypted,stored_filename,mime_type,size_bytes,sha256)
    VALUES (?, ?, ?, ?, ?, 'application/pdf', 0, ?)`)
    .run(docId, OWNER_ID, crypto.encrypt('fixture.pdf'), crypto.encrypt('Fixture document'),
      `owner-${OWNER_ID}/${docId}.pdf`, '0'.repeat(64));
  db.prepare('INSERT INTO document_associations (document_id,entry_id) VALUES (?,?)').run(docId, fixture.closed);
  await request(`/api/documents?entryId=${fixture.closed}`, { status: 404 });
  assert.deepEqual(await request(`/api/documents?entryId=${fixture.current}`), []);
  const counts = await request('/api/documents/counts');
  assert.deepEqual(counts.map(c => c.entry_id).sort((a, b) => a - b), visibleIds());
  assert.ok(counts.every(c => c.count === 0));
  await request('/api/documents/beneficiary/content', { method: 'POST', status: 404,
    body: { accessToken: BENEFICIARY_TOKEN, documentId: docId, mode: 'preview' } });
});

const FIRST_LEDGER = {
  currency: 'ZAR', initial: 0, reconciled: 342328.04, cleared: 342328.04,
  today: 342328.04, future: 342328.04, last_transaction: '2020-09-15'
};
const NEXT_LEDGER = {
  currency: 'EUR', initial: 10.12, reconciled: 20.23, cleared: 30.34,
  today: -40.45, future: 50.56, last_transaction: '2026-10-24'
};

function ledgerNotes(ledger, date) {
  return `HomeBank ledger balances as of ${date}:\n` +
    ['Initial', 'Reconciled', 'Cleared', 'Today', 'Future']
      .map(label => `${label}: ${ledger.currency} ${ledger[label.toLowerCase()].toFixed(2)}`).join('\n') +
    `\nLast recorded transaction: ${ledger.last_transaction}`;
}

function dynamicFixture() {
  const targets = [
    { id: fixture.current, title: 'Fixture current account', accountId: 101,
      section: 'bank_accounts', balanceKey: 'balance_approx', providerKey: 'bank_name',
      sourceProviderKey: 'bank_name', provider: 'Fixture Bank',
      fields: { bank_name: 'Old bank', balance_approx: 'ZAR 999.99', nominee: 'Fixture nominee' } },
    { id: fixture.savings, title: 'Fixture savings account', accountId: 106,
      section: 'bank_accounts', balanceKey: 'balance_approx', providerKey: 'bank_name',
      sourceProviderKey: 'bank_name', provider: 'Fixture Savings Bank',
      fields: { account_type: 'Savings', balance_approx: 'ZAR 999.99' } },
    { id: fixture.property, title: 'Fixture property', accountId: 105,
      section: 'real_estate', balanceKey: 'current_value', providerKey: 'mortgage_provider',
      sourceProviderKey: 'mortgage_provider', provider: 'Fixture Mortgage',
      fields: { current_value: 'Owner valuation', mortgage_balance: 'Owner mortgage balance' } },
    { title: 'Fixture dynamic debt', accountId: 107,
      section: 'debts', balanceKey: 'outstanding', providerKey: 'creditor',
      sourceProviderKey: 'bank_name', provider: 'Fixture Creditor',
      fields: { outstanding: 'ZAR 999.99', monthly_payment: 'Owner payment' } },
    { title: 'Fixture dynamic vehicle', accountId: 108,
      section: 'vehicles', balanceKey: 'loan_balance', providerKey: 'loan_provider',
      sourceProviderKey: 'loan_provider', provider: 'Fixture Vehicle Finance',
      fields: { registration: 'FIXTURE-ONLY', loan_balance: 'Owner vehicle loan balance' } },
    { title: 'Fixture dynamic investment', accountId: 109,
      section: 'investments', balanceKey: 'value_approx', providerKey: 'institution',
      sourceProviderKey: 'bank_name', provider: 'Fixture Investment Platform',
      fields: { type: 'Other', nominee: 'Fixture nominee' } },
    { title: 'Fixture dynamic retirement', accountId: 110,
      section: 'retirement', balanceKey: 'value_approx', providerKey: 'provider',
      sourceProviderKey: 'bank_name', provider: 'Fixture Retirement Provider',
      fields: { beneficiary: 'Fixture beneficiary' } }
  ];
  for (const target of targets) {
    const notes = provenance(target.accountId) + '\nOld imported bookkeeping and narrative must disappear.';
    if (target.id) {
      db.prepare('UPDATE vault_entries SET fields_encrypted=?,notes_encrypted=? WHERE id=?')
        .run(crypto.encrypt(JSON.stringify(target.fields)), crypto.encrypt(notes), target.id);
    } else target.id = addEntry({ ...target, notes });
  }
  db.prepare('UPDATE vault_entries SET fields_encrypted=?,notes_encrypted=? WHERE id=?')
    .run(crypto.encrypt(JSON.stringify({ balance_approx: 'Owner manual balance', bank_name: 'Owner manual bank' })),
      crypto.encrypt('Owner manual notes'), fixture.manual);
  const accounts = SOURCE_ACCOUNTS.map(account => ({ ...account }));
  for (const target of targets) {
    let account = accounts.find(a => a.id === target.accountId);
    if (!account) {
      account = { id: target.accountId, name: target.title, closed: false, excluded_from_summary: false };
      accounts.push(account);
    }
    Object.assign(account, FIRST_LEDGER, { [target.sourceProviderKey]: `${target.provider} Alpha` });
  }
  setSnapshot(accounts);
  return { targets, accounts };
}

function assertDynamicEntries(entries, targets, ledger, date, providerSuffix) {
  for (const target of targets) {
    const entry = entries.find(e => e.title === target.title);
    assert.ok(entry, `Missing ${target.section} fixture: ${target.title}`);
    assert.equal(entry.notes, '', `${target.section} must not display imported notes`);
    assert.equal(entry.fields[target.balanceKey], `${ledger.currency} ${ledger.today.toFixed(2)}`,
      `${target.section} balance must come from the latest source`);
    assert.equal(entry.fields[target.providerKey], `${target.provider} ${providerSuffix}`,
      `${target.section} provider must come from the latest explicit metadata`);
    for (const field of ['nominee', 'account_type', 'mortgage_balance', 'monthly_payment',
      'registration', 'beneficiary']) {
      if (target.fields[field]) assert.equal(entry.fields[field], target.fields[field], `${field} must stay manually managed`);
    }
  }
  const manual = entries.find(e => e.title === 'Fixture manual account');
  if (manual) {
    assert.equal(manual.notes, 'Owner manual notes');
    assert.deepEqual(manual.fields, { balance_approx: 'Owner manual balance', bank_name: 'Owner manual bank' });
  }
}

async function assertDynamicReadSurfaces(targets, ledger, date, providerSuffix) {
  assertDynamicEntries((await request('/api/vault/entries?limit=100')).entries, targets, ledger, date, providerSuffix);
  for (const target of targets) {
    assertDynamicEntries([await request(`/api/vault/entries/${target.id}`)], [target], ledger, date, providerSuffix);
  }
  assertDynamicEntries(await request('/api/vault/search?q=Fixture'), targets, ledger, date, providerSuffix);
  assertDynamicEntries((await request('/api/vault/export')).entries, targets, ledger, date, providerSuffix);
  assertDynamicEntries((await request('/api/vault/backup')).entries, targets, ledger, date, providerSuffix);
  const beneficiary = await request('/api/beneficiaries/access', {
    method: 'POST', body: { accessToken: BENEFICIARY_TOKEN }
  });
  assertDynamicEntries(beneficiary.entries, targets, ledger, date, providerSuffix);
}

test('all vault read surfaces omit imported notes and project the latest balances and explicit providers', async () => {
  const { targets, accounts } = dynamicFixture();
  await assertDynamicReadSurfaces(targets, FIRST_LEDGER, '2026-10-25', 'Alpha');
  assert.ok(syncCalls.length >= targets.length + 5, 'Each read surface must check the saved source before projecting');
  assert.ok(syncCalls.every(id => id === OWNER_ID));

  const next = accounts.map(account => {
    const target = targets.find(t => t.accountId === account.id);
    return target ? { ...account, ...NEXT_LEDGER, [target.sourceProviderKey]: `${target.provider} Beta` } : account;
  });
  // Simulate the next saved source version becoming available to the source
  // service. A normal vault GET must refresh it without a separate sync click.
  sourceUpdateOnSync = () => setSnapshot(next, { exportedDate: '2026-10-26' });
  await assertDynamicReadSurfaces(targets, NEXT_LEDGER, '2026-10-26', 'Beta');

  const sourceSearch = await request('/api/vault/search?q=EUR%20-40.45');
  assert.deepEqual(ids(sourceSearch), ids(targets));
  assert.deepEqual(await request('/api/vault/search?q=Old%20imported%20bookkeeping'), []);
});

test('linked edits, creates, and restored backups do not persist projected notes or balances', async () => {
  const { targets, accounts } = dynamicFixture();
  for (const target of targets) {
    const edit = await request(`/api/vault/entries/${target.id}`);
    edit.fields.owner_reference = 'Owner retained reference';
    await request(`/api/vault/entries/${target.id}`, { method: 'PUT', body: edit });
    const stored = db.prepare('SELECT * FROM vault_entries WHERE id=?').get(target.id);
    const fields = JSON.parse(crypto.decrypt(stored.fields_encrypted));
    assert.equal(fields[target.balanceKey], undefined, `${target.section} must not store its projected balance`);
    assert.equal(stored.notes_encrypted ? crypto.decrypt(stored.notes_encrypted) : '', '');
    assert.equal(fields.owner_reference, 'Owner retained reference');
    assert.equal(stored.homebank_account_id, target.accountId);
  }

  const backup = await request('/api/vault/backup');
  await request('/api/vault/restore', { method: 'POST', body: { mode: 'overwrite', entries: backup.entries } });
  for (const target of targets) {
    const stored = db.prepare('SELECT * FROM vault_entries WHERE user_id=? AND title=?').get(OWNER_ID, target.title);
    assert.equal(JSON.parse(crypto.decrypt(stored.fields_encrypted))[target.balanceKey], undefined);
    assert.equal(stored.notes_encrypted ? crypto.decrypt(stored.notes_encrypted) : '', '');
    target.id = stored.id;
  }

  const created = await request('/api/vault/entries', { method: 'POST', body: {
    section: 'bank_accounts', title: 'Fixture newly linked account', homebank_account_id: 101,
    fields: { balance_approx: 'ZAR 111.11', owner_reference: 'New owner reference' },
    notes: ledgerNotes(FIRST_LEDGER, '2026-10-25')
  } });
  const storedNew = db.prepare('SELECT * FROM vault_entries WHERE id=?').get(created.id);
  assert.equal(JSON.parse(crypto.decrypt(storedNew.fields_encrypted)).balance_approx, undefined);
  assert.equal(storedNew.notes_encrypted ? crypto.decrypt(storedNew.notes_encrypted) : '', '');

  setSnapshot(accounts.map(a => ({ ...a, ...NEXT_LEDGER })), { exportedDate: '2026-10-26' });
  await assertDynamicReadSurfaces(targets, NEXT_LEDGER, '2026-10-26', 'Alpha');
});

test('a source parse error keeps last valid projected values and filtering still hides deleted source accounts', async () => {
  const { targets, accounts } = dynamicFixture();
  setSnapshot(accounts, { lastError: 'Fixture invalid XML while an external editor is saving' });
  await assertDynamicReadSurfaces(targets, FIRST_LEDGER, '2026-10-25', 'Alpha');

  const hidden = targets.find(t => t.section === 'vehicles');
  setSnapshot(accounts.filter(a => a.id !== hidden.accountId));
  await request(`/api/vault/entries/${hidden.id}`, { status: 404 });
  assert.ok(!(await request('/api/vault/entries?limit=100')).entries.some(e => e.id === hidden.id));
  assert.ok(db.prepare('SELECT id FROM vault_entries WHERE id=?').get(hidden.id));
  const deleted = targets.find(t => t.section === 'debts');
  await request(`/api/vault/entries/${deleted.id}`, { method: 'DELETE' });
  sourceUpdateOnSync = () => setSnapshot(accounts);
  await request('/api/vault/entries');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vault_entries WHERE homebank_account_id=?').get(deleted.accountId).n, 0);
});

test('vehicle and property balances use the requested fields without inventing a lender', async () => {
  const { targets, accounts } = dynamicFixture();
  for (const target of targets.filter(t => ['vehicles', 'real_estate'].includes(t.section))) {
    const fields = { owner_reference: 'Fixture owner value' };
    db.prepare('UPDATE vault_entries SET fields_encrypted=? WHERE id=?')
      .run(crypto.encrypt(JSON.stringify(fields)), target.id);
    const source = accounts.find(a => a.id === target.accountId);
    delete source[target.sourceProviderKey];
    source.name = 'Fixture asset with no finance metadata';
    source.bank_name = 'Fixture Asset Custodian';
  }
  setSnapshot(accounts);
  for (const target of targets.filter(t => ['vehicles', 'real_estate'].includes(t.section))) {
    const entry = await request(`/api/vault/entries/${target.id}`);
    assert.equal(entry.fields[target.balanceKey], 'ZAR 342328.04');
    assert.equal(entry.fields.homebank_balance, undefined);
    assert.equal(entry.fields.mortgage_balance, undefined);
    assert.equal(entry.fields[target.providerKey], undefined);
  }
});

test('a debt creditor inferred from an explicit source-name prefix changes with that source name', async () => {
  const { targets, accounts } = dynamicFixture();
  const debt = targets.find(t => t.section === 'debts');
  const source = accounts.find(a => a.id === debt.accountId);
  delete source.bank_name;
  source.name = 'FNB Fixture finance account';
  setSnapshot(accounts);
  assert.equal((await request(`/api/vault/entries/${debt.id}`)).fields.creditor, 'FNB');

  source.name = 'Investec Fixture finance account';
  sourceUpdateOnSync = () => setSnapshot(accounts);
  assert.equal((await request(`/api/vault/entries/${debt.id}`)).fields.creditor, 'Investec');
});
