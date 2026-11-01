'use strict';

// A separate in-memory database and temporary, synthetic XHB source are injected
// before the service is loaded. The application vault is never opened.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { spawn } = require('node:child_process');
const Database = require('better-sqlite3');
process.env.ENCRYPTION_KEY = 'ca'.repeat(32);
const vaultCrypto = require('../server/crypto');

const SERVICE_PATH = path.resolve(__dirname, '../server/homebank-service.js');
const SERVICE_SOURCE = fs.readFileSync(SERVICE_PATH, 'utf8');
const requireFromService = createRequire(SERVICE_PATH);
const USER_ID = 901;
const OWNER_EMAIL = 'fixture-homebank-owner@example.test';
const xml = initial => `<homebank v="1.6"><grp key="7" name="Savings Accounts"/>
  <account key="1" type="1" name="Fixture bank" grp="7"
  bankname="Fixture institution" number="00012345" initial="${initial}"/></homebank>`;

function today() {
  const d = new Date();
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0')].join('-');
}

async function fixture(t, schemaVersion) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'vault-homebank-service-'));
  const source = path.join(directory, 'fixture.xhb');
  await fsp.writeFile(source, xml(100));
  const db = new Database(':memory:');
  t.after(async () => { db.close(); await fsp.rm(directory, { recursive: true, force: true }); });
  db.exec(`CREATE TABLE homebank_snapshots (
    user_id INTEGER PRIMARY KEY, config_encrypted TEXT, snapshot_encrypted TEXT,
    fingerprint TEXT, source_file TEXT, source_saved_at TEXT, synced_at TEXT,
    last_error TEXT, content_hash TEXT
  );
  CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL);
  CREATE TABLE vault_entries (
    id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, section TEXT NOT NULL,
    title TEXT NOT NULL, fields_encrypted TEXT NOT NULL, notes_encrypted TEXT,
    homebank_account_id INTEGER, updated_at TEXT
  )`);
  let parseCalls = 0;
  const isolatedModule = { exports: {} };
  const context = {
    module: isolatedModule, exports: isolatedModule.exports, __dirname: path.dirname(SERVICE_PATH),
    process: { env: { ...process.env, HOMEBANK_ALLOWED_ROOT: directory, HOMEBANK_DIRECTORY: directory,
      HOMEBANK_OWNER_EMAIL: OWNER_EMAIL } },
    setTimeout, clearTimeout, setInterval, console,
    require(name) {
      if (name === './db') return { getDb: () => db, audit() {} };
      // These values stay entirely in the synthetic database.
      if (name === './crypto') return { encrypt: value => value, decrypt: value => value };
      if (name === 'node:child_process') return {
        spawn(...args) { parseCalls += 1; return spawn(...args); }
      };
      return requireFromService(name);
    }
  };
  vm.runInNewContext(SERVICE_SOURCE, context, { filename: SERVICE_PATH });
  const service = isolatedModule.exports;
  const [file] = await service.listing(directory);
  const snapshot = { exported_date: today(), accounts: [{ id: 1, name: 'Cached fixture', type_id: 1,
    group_name: 'Savings Accounts', closed: false, excluded_from_summary: false }] };
  if (schemaVersion !== undefined) snapshot.snapshot_schema_version = schemaVersion;
  db.prepare(`INSERT INTO homebank_snapshots
    (user_id, config_encrypted, snapshot_encrypted, fingerprint, source_file)
    VALUES (?, ?, ?, ?, ?)`)
    .run(USER_ID, JSON.stringify({ directory, selectedFile: 'fixture.xhb', auto: true }),
      JSON.stringify(snapshot), file.fingerprint, file.name);
  return { db, source, service, parseCalls: () => parseCalls };
}

for (const version of [undefined, 1, 2]) {
  test(`an unchanged source is reparsed for ${version === undefined ? 'unversioned' : `version ${version}`} cached snapshots`, async t => {
    const f = await fixture(t, version);
    const originalSource = await fsp.readFile(f.source);
    const refreshed = f.service.responseView(await f.service.syncUser(USER_ID));
    assert.equal(f.parseCalls(), 1);
    assert.equal(refreshed.last_error, null);
    assert.equal(refreshed.snapshot.snapshot_schema_version, 3);
    assert.equal(refreshed.snapshot.accounts[0].bank_name, 'Fixture institution');
    assert.equal(refreshed.snapshot.accounts[0].account_number, '00012345');
    assert.equal(refreshed.snapshot.accounts[0].group_id, 7);
    assert.equal(refreshed.snapshot.accounts[0].group_name, 'Savings Accounts');
    assert.deepEqual(await fsp.readFile(f.source), originalSource);
  });
}

test('current version snapshots keep the unchanged-source cache', async t => {
  const f = await fixture(t, 3);
  const before = f.db.prepare('SELECT snapshot_encrypted FROM homebank_snapshots').get().snapshot_encrypted;
  const result = await f.service.syncUser(USER_ID);
  assert.equal(f.parseCalls(), 0);
  assert.equal(result.snapshot_encrypted, before);
});

test('a saved source updates ledger amounts and metadata on the next automatic sync', async t => {
  const f = await fixture(t, 3);
  await fsp.writeFile(f.source, xml(250).replace('Fixture institution', 'Updated fixture institution')
    .replace('Savings Accounts', 'Retirement Accounts'));
  const changed = f.service.responseView(await f.service.syncUser(USER_ID));
  assert.equal(f.parseCalls(), 1);
  assert.equal(changed.last_error, null);
  assert.equal(changed.snapshot.accounts[0].today, 250);
  assert.equal(changed.snapshot.accounts[0].bank_name, 'Updated fixture institution');
  assert.equal(changed.snapshot.accounts[0].group_name, 'Retirement Accounts');
  await f.service.syncUser(USER_ID);
  assert.equal(f.parseCalls(), 1, 'The freshly parsed source should be cached');
});

test('saved source groups realign linked entries during refresh and on unchanged-cache reads', async t => {
  const f = await fixture(t, 3);
  f.db.prepare('INSERT INTO users (id,email) VALUES (?,?)').run(USER_ID, OWNER_EMAIL);
  const fields = { institution: 'Fixture owner institution', type: 'Bonds',
    owner_reference: 'Keep this owner field' };
  f.db.prepare(`INSERT INTO vault_entries
    (id,user_id,section,title,fields_encrypted,homebank_account_id,updated_at)
    VALUES (1,?,'investments','Fixture owner title',?,1,'2020-01-01')`)
    .run(USER_ID, vaultCrypto.encrypt(JSON.stringify(fields)));
  await fsp.writeFile(f.source, xml(250).replace('Savings Accounts', 'Retirement Annuity'));
  const sourceBefore = await fsp.readFile(f.source);
  const refreshed = f.service.responseView(await f.service.syncUser(USER_ID));
  assert.equal(refreshed.last_error, null);
  assert.equal(f.parseCalls(), 1);
  const entry = f.db.prepare('SELECT * FROM vault_entries WHERE id=1').get();
  assert.equal(entry.section, 'retirement');
  assert.equal(entry.title, 'Fixture owner title');
  assert.equal(entry.homebank_account_id, 1);
  const alignedFields = JSON.parse(vaultCrypto.decrypt(entry.fields_encrypted));
  assert.equal(alignedFields.investment_type, 'Bonds');
  assert.equal(alignedFields.owner_reference, 'Keep this owner field');
  assert.equal(alignedFields.homebank_group, undefined);
  assert.equal(refreshed.snapshot.accounts[0].group_name, 'Retirement Annuity');

  // A newly linked or restored record may need alignment even when the saved
  // source itself has not changed. The cache must still reconcile that record.
  f.db.prepare("UPDATE vault_entries SET section='investments',fields_encrypted=? WHERE id=1")
    .run(vaultCrypto.encrypt(JSON.stringify(fields)));
  await f.service.syncUser(USER_ID);
  const cachedEntry = f.db.prepare('SELECT * FROM vault_entries WHERE id=1').get();
  assert.equal(cachedEntry.section, 'retirement');
  assert.equal(JSON.parse(vaultCrypto.decrypt(cachedEntry.fields_encrypted)).investment_type, 'Bonds');
  assert.equal(f.parseCalls(), 1, 'Entry reconciliation must not force another source parse');
  await f.service.syncUser(USER_ID);
  assert.deepEqual(f.db.prepare('SELECT * FROM vault_entries WHERE id=1').get(), cachedEntry,
    'Subsequent cached reads must retain unchanged ciphertext and timestamps');
  assert.deepEqual(await fsp.readFile(f.source), sourceBefore);
});

test('a fresh sync keeps legacy saved connections active and creates owner source identities without copied fields', async t => {
  const f = await fixture(t, 3);
  f.db.prepare('INSERT INTO users (id,email) VALUES (?,?)').run(USER_ID, OWNER_EMAIL);
  const sourceBefore = await fsp.readFile(f.source);
  const refreshed = f.service.responseView(await f.service.syncUser(USER_ID, true));
  assert.equal(refreshed.last_error, null);
  assert.equal(f.parseCalls(), 1);
  const added = f.db.prepare('SELECT * FROM vault_entries').all();
  assert.equal(added.length, 1);
  assert.equal(added[0].user_id, USER_ID);
  assert.equal(added[0].title, 'Fixture bank');
  assert.equal(added[0].section, 'bank_accounts');
  assert.equal(added[0].homebank_account_id, 1);
  assert.deepEqual(JSON.parse(vaultCrypto.decrypt(added[0].fields_encrypted)), {});
  assert.equal(added[0].notes_encrypted, null);
  await f.service.syncUser(USER_ID, true);
  assert.deepEqual(f.db.prepare('SELECT * FROM vault_entries').all(), added);
  assert.deepEqual(await fsp.readFile(f.source), sourceBefore);
});

test('unchanged legacy connected snapshots create missing active identities once across overlapping requests', async t => {
  const f = await fixture(t, 3);
  f.db.prepare('INSERT INTO users (id,email) VALUES (?,?)').run(USER_ID, OWNER_EMAIL);
  const original = f.db.prepare('SELECT snapshot_encrypted FROM homebank_snapshots').get().snapshot_encrypted;
  await Promise.all(Array.from({ length: 6 }, () => f.service.syncUser(USER_ID)));
  assert.equal(f.parseCalls(), 0);
  const added = f.db.prepare('SELECT * FROM vault_entries').all();
  assert.equal(added.length, 1);
  assert.equal(added[0].title, 'Cached fixture');
  assert.equal(added[0].homebank_account_id, 1);
  await f.service.syncUser(USER_ID);
  assert.deepEqual(f.db.prepare('SELECT * FROM vault_entries').all(), added);
  assert.equal(f.db.prepare('SELECT snapshot_encrypted FROM homebank_snapshots').get().snapshot_encrypted, original);
});

test('default directory discovery never adds account cards until the source is explicitly connected', async t => {
  const f = await fixture(t, 3);
  f.db.prepare('INSERT INTO users (id,email) VALUES (?,?)').run(USER_ID, OWNER_EMAIL);
  f.db.prepare('DELETE FROM homebank_snapshots WHERE user_id=?').run(USER_ID);
  const initial = f.service.responseView(await f.service.syncUser(USER_ID));
  assert.equal(initial.last_error, null);
  assert.equal(initial.snapshot.accounts.length, 1, 'Default discovery still supplies the existing overview');
  assert.equal(initial.config.accounts_connected, false);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM vault_entries').get().count, 0);
  const cached = f.service.responseView(await f.service.syncUser(USER_ID));
  assert.equal(cached.config.accounts_connected, false);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM vault_entries').get().count, 0);
  await fsp.writeFile(f.source, xml(500).replace('</homebank>',
    '<account key="2" name="Another discovered fixture" type="6"/></homebank>'));
  const changed = f.service.responseView(await f.service.syncUser(USER_ID));
  assert.equal(changed.snapshot.accounts.length, 2);
  assert.equal(changed.config.accounts_connected, false);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM vault_entries').get().count, 0);
});

test('legacy unconnected settings remain unconnected after automatic discovery and preserve other configuration', async t => {
  const f = await fixture(t, 3);
  f.db.prepare('INSERT INTO users (id,email) VALUES (?,?)').run(USER_ID, OWNER_EMAIL);
  const config = { directory: path.dirname(f.source), selectedFile: '', auto: true, future_setting: 'Preserve this' };
  f.db.prepare(`UPDATE homebank_snapshots SET config_encrypted=?,snapshot_encrypted=NULL,
    source_file=NULL,fingerprint=NULL WHERE user_id=?`).run(JSON.stringify(config), USER_ID);
  const discovered = f.service.responseView(await f.service.syncUser(USER_ID));
  assert.equal(discovered.config.accounts_connected, false);
  assert.equal(discovered.config.future_setting, config.future_setting);
  await f.service.syncUser(USER_ID);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM vault_entries').get().count, 0);
  assert.equal(f.parseCalls(), 1);
});

test('Save and sync connects the source, retains configuration and adds later new accounts exactly once', async t => {
  const f = await fixture(t, 3);
  f.db.prepare('INSERT INTO users (id,email) VALUES (?,?)').run(USER_ID, OWNER_EMAIL);
  const config = JSON.parse(f.db.prepare('SELECT config_encrypted FROM homebank_snapshots').get().config_encrypted);
  config.accounts_connected = false;
  config.future_setting = 'Preserve this';
  f.db.prepare('UPDATE homebank_snapshots SET config_encrypted=?').run(JSON.stringify(config));
  await f.service.syncUser(USER_ID);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM vault_entries').get().count, 0);
  const connected = f.service.responseView(await f.service.saveSettings(USER_ID,
    { directory: path.dirname(f.source), selectedFile: path.basename(f.source) }));
  assert.equal(connected.last_error, null);
  assert.equal(connected.config.accounts_connected, true);
  assert.equal(connected.config.future_setting, config.future_setting);
  const first = f.db.prepare('SELECT * FROM vault_entries').all();
  assert.equal(first.length, 1);
  assert.equal(first[0].homebank_account_id, 1);
  await fsp.writeFile(f.source, xml(250).replace('</homebank>',
    '<account key="2" name="New connected fixture" type="6"/></homebank>'));
  const later = f.service.responseView(await f.service.syncUser(USER_ID));
  assert.equal(later.last_error, null);
  assert.equal(later.snapshot.accounts.length, 2);
  const added = f.db.prepare('SELECT * FROM vault_entries ORDER BY homebank_account_id').all();
  assert.equal(added.length, 2);
  assert.deepEqual(added[0], first[0]);
  assert.equal(added[1].homebank_account_id, 2);
  await f.service.syncUser(USER_ID);
  assert.deepEqual(f.db.prepare('SELECT * FROM vault_entries ORDER BY homebank_account_id').all(), added);
});

test('a saved source adds new active accounts while preserving existing owner edits and skipping hidden accounts', async t => {
  const f = await fixture(t, 3);
  f.db.prepare('INSERT INTO users (id,email) VALUES (?,?)').run(USER_ID, OWNER_EMAIL);
  await f.service.syncUser(USER_ID, true);
  const ownerFields = vaultCrypto.encrypt(JSON.stringify({ owner_reference: 'Keep this private owner detail' }));
  f.db.prepare("UPDATE vault_entries SET title='Owner chosen title',fields_encrypted=?,updated_at='2020-01-01'")
    .run(ownerFields);
  const original = f.db.prepare('SELECT * FROM vault_entries WHERE homebank_account_id=1').get();
  // Native XHB flags: closed=2, excluded from summary=16.
  await fsp.writeFile(f.source, xml(500).replace('Fixture bank', 'Source renamed bank')
    .replace('</homebank>', '<account key="2" name="New fixture bank" type="6"/>' +
      '<account key="3" name="Closed fixture bank" type="1" flags="2"/>' +
      '<account key="4" name="Excluded fixture bank" type="1" flags="16"/></homebank>'));
  const sourceBefore = await fsp.readFile(f.source);
  const result = f.service.responseView(await f.service.syncUser(USER_ID));
  assert.equal(result.last_error, null);
  assert.equal(result.snapshot.accounts.find(account => account.id === 1).today, 500);
  assert.deepEqual(f.db.prepare('SELECT * FROM vault_entries WHERE homebank_account_id=1').get(), original);
  assert.deepEqual(f.db.prepare('SELECT homebank_account_id FROM vault_entries ORDER BY homebank_account_id').all(),
    [{ homebank_account_id: 1 }, { homebank_account_id: 2 }]);
  const entries = f.db.prepare('SELECT * FROM vault_entries ORDER BY id').all();
  await f.service.syncUser(USER_ID);
  assert.deepEqual(f.db.prepare('SELECT * FROM vault_entries ORDER BY id').all(), entries);
  assert.equal(f.parseCalls(), 2);
  assert.deepEqual(await fsp.readFile(f.source), sourceBefore);
});

test('an explicitly allocated vehicle survives fresh and cached sync with its source valuation and owner loan separate', async t => {
  const f = await fixture(t, 3);
  const { projectHomebankEntry } = require('../server/homebank-vault');
  f.db.prepare('INSERT INTO users (id,email) VALUES (?,?)').run(USER_ID, OWNER_EMAIL);
  const fields = { registration: 'EXAMPLE-123', loan_balance: 'ZAR 900.00',
    loan_provider: 'Example owner lender', owner_reference: 'Keep this vehicle detail' };
  f.db.prepare(`INSERT INTO vault_entries
    (id,user_id,section,title,fields_encrypted,notes_encrypted,homebank_account_id,updated_at)
    VALUES (1,?,'vehicles','Owner vehicle title',?,?,1,'2020-01-01')`)
    .run(USER_ID, vaultCrypto.encrypt(JSON.stringify(fields)), vaultCrypto.encrypt('Retained historical notes'));
  f.db.exec('CREATE TABLE document_associations (document_id TEXT, entry_id INTEGER)');
  f.db.prepare('INSERT INTO document_associations VALUES (?,1)').run('synthetic-vehicle-document');
  const original = f.db.prepare('SELECT * FROM vault_entries WHERE id=1').get();
  const documents = f.db.prepare('SELECT * FROM document_associations').all();
  await fsp.writeFile(f.source, `<homebank v="1.6"><grp key="7" name="Household"/>
    <account key="1" type="3" name="Synthetic source asset" grp="7" initial="250"/>
    <account key="2" type="3" name="New synthetic asset" grp="7" initial="75"/></homebank>`);
  const sourceBefore = await fsp.readFile(f.source);
  const fresh = f.service.responseView(await f.service.syncUser(USER_ID, true));
  assert.equal(fresh.last_error, null);
  assert.deepEqual(f.db.prepare('SELECT * FROM vault_entries WHERE id=1').get(), original);
  const projected = projectHomebankEntry({ ...original, fields },
    { accountForEntry: entry => fresh.snapshot.accounts.find(account => account.id === entry.homebank_account_id) });
  assert.equal(projected.section, 'vehicles');
  assert.equal(projected.fields.current_value, 'ZAR 250.00', 'Asset ledger is the vehicle valuation');
  assert.equal(projected.fields.loan_balance, fields.loan_balance, 'Source valuation must not become the owner loan');
  assert.equal(projected.fields.loan_provider, fields.loan_provider);
  assert.equal(projected.fields.registration, fields.registration);
  assert.deepEqual(f.db.prepare('SELECT * FROM document_associations').all(), documents);
  const entries = f.db.prepare('SELECT * FROM vault_entries ORDER BY id').all();
  assert.equal(entries.length, 2);
  assert.equal(entries[1].homebank_account_id, 2);
  assert.equal(entries[1].section, 'investments', 'A separate missing generic asset is still created once');
  assert.deepEqual(JSON.parse(vaultCrypto.decrypt(entries[1].fields_encrypted)), {});
  await f.service.syncUser(USER_ID);
  await f.service.syncUser(USER_ID);
  assert.equal(f.parseCalls(), 1, 'Subsequent connected syncs use the validated unchanged source');
  assert.deepEqual(f.db.prepare('SELECT * FROM vault_entries ORDER BY id').all(), entries);
  assert.deepEqual(f.db.prepare('SELECT * FROM document_associations').all(), documents);
  assert.deepEqual(await fsp.readFile(f.source), sourceBefore);
});

test('saved institution allocations apply on fresh and cached sync without moving unmatched assets or losing owner data', async t => {
  const f = await fixture(t, 3);
  const allocations = [{ institution: 'Example Owner’s Garage', section: 'vehicles' },
    { institution: 'Example Property Office', section: 'real_estate' }];
  f.db.prepare('INSERT INTO users (id,email) VALUES (?,?)').run(USER_ID, OWNER_EMAIL);
  const config = JSON.parse(f.db.prepare('SELECT config_encrypted FROM homebank_snapshots').get().config_encrypted);
  f.db.prepare('UPDATE homebank_snapshots SET config_encrypted=?')
    .run(JSON.stringify({ ...config, institution_allocations: allocations }));
  const ownerFields = { registration: 'EXAMPLE-ALLOCATION', loan_balance: 'ZAR 900.00',
    loan_provider: 'Example owner lender', owner_reference: 'Keep this allocation detail' };
  const insert = f.db.prepare(`INSERT INTO vault_entries
    (id,user_id,section,title,fields_encrypted,homebank_account_id,updated_at)
    VALUES (?,?,'investments',?,?,?,'2020-01-01')`);
  insert.run(1, USER_ID, 'Owner vehicle title', vaultCrypto.encrypt(JSON.stringify(ownerFields)), 1);
  insert.run(2, USER_ID, 'Owner unmatched asset', vaultCrypto.encrypt(JSON.stringify({ owner_reference: 'Unmatched owner detail' })), 2);
  f.db.exec('CREATE TABLE document_associations (document_id TEXT, entry_id INTEGER)');
  f.db.prepare('INSERT INTO document_associations VALUES (?,1)').run('synthetic-allocation-document');
  const documents = f.db.prepare('SELECT * FROM document_associations').all();
  const originalVehicle = f.db.prepare('SELECT * FROM vault_entries WHERE id=1').get();
  const unmatched = f.db.prepare('SELECT * FROM vault_entries WHERE id=2').get();
  const source = `<homebank v="1.6"><grp key="7" name="Investments"/>
    <account key="1" type="3" name="Synthetic mapped asset" grp="7"
      bankname="  eXAMPLE   Owner's   Garage  " initial="250"/>
    <account key="2" type="3" name="Synthetic unmatched asset" grp="7"
      bankname="Example Owner's Garage West" initial="500"/>
    <account key="3" type="3" name="Synthetic closed mapped asset" grp="7"
      bankname="Example Owner's Garage" flags="2" initial="10"/>
    <account key="4" type="3" name="Synthetic excluded mapped asset" grp="7"
      bankname="Example Owner's Garage" flags="16" initial="20"/>
    <account key="5" type="5" name="Synthetic mapped liability" grp="7"
      bankname="Example Owner's Garage" initial="-30"/></homebank>`;
  await fsp.writeFile(f.source, source);
  const fresh = f.service.responseView(await f.service.syncUser(USER_ID, true));
  assert.equal(fresh.last_error, null);
  const vehicle = f.db.prepare('SELECT * FROM vault_entries WHERE id=1').get();
  assert.equal(vehicle.section, 'vehicles', 'Explicit institution allocation overrides the source investment group');
  for (const key of ['id', 'user_id', 'title', 'homebank_account_id', 'updated_at']) assert.equal(vehicle[key], originalVehicle[key]);
  assert.deepEqual(JSON.parse(vaultCrypto.decrypt(vehicle.fields_encrypted)), ownerFields);
  assert.deepEqual(f.db.prepare('SELECT * FROM vault_entries WHERE id=2').get(), unmatched,
    'Institution matching is exact rather than a provider-name prefix');
  assert.deepEqual(f.db.prepare('SELECT homebank_account_id,section FROM vault_entries ORDER BY homebank_account_id').all(),
    [{ homebank_account_id: 1, section: 'vehicles' }, { homebank_account_id: 2, section: 'investments' },
      { homebank_account_id: 5, section: 'debts' }]);
  assert.deepEqual(f.db.prepare('SELECT * FROM document_associations').all(), documents);

  // An older restored section must be repaired even when the source is cached.
  f.db.prepare("UPDATE vault_entries SET section='investments' WHERE id=1").run();
  await f.service.syncUser(USER_ID);
  assert.deepEqual(f.db.prepare('SELECT * FROM vault_entries WHERE id=1').get(), vehicle);
  assert.equal(f.parseCalls(), 1);

  await fsp.writeFile(f.source, source.replace('</homebank>',
    '<account key="6" type="3" name="New synthetic mapped vehicle" grp="7" bankname="Example Owner’s Garage"/>' +
    '<account key="7" type="3" name="New synthetic mapped property" grp="7" bankname="EXAMPLE PROPERTY OFFICE"/>' +
    '<account key="8" type="3" name="New synthetic unmatched asset" grp="7" bankname="Other Example Office"/></homebank>'));
  const sourceBefore = await fsp.readFile(f.source);
  const saved = f.service.responseView(await f.service.saveSettings(USER_ID,
    { directory: path.dirname(f.source), selectedFile: path.basename(f.source) }));
  assert.equal(saved.last_error, null);
  assert.equal(JSON.stringify(saved.config.institution_allocations), JSON.stringify(allocations),
    'Save and sync retains the encrypted owner institution allocations');
  assert.deepEqual(f.db.prepare('SELECT homebank_account_id,section FROM vault_entries ORDER BY homebank_account_id').all(),
    [{ homebank_account_id: 1, section: 'vehicles' }, { homebank_account_id: 2, section: 'investments' },
      { homebank_account_id: 5, section: 'debts' }, { homebank_account_id: 6, section: 'vehicles' },
      { homebank_account_id: 7, section: 'real_estate' }, { homebank_account_id: 8, section: 'investments' }]);
  const entries = f.db.prepare('SELECT * FROM vault_entries ORDER BY id').all();
  await f.service.syncUser(USER_ID);
  await f.service.syncUser(USER_ID);
  assert.deepEqual(f.db.prepare('SELECT * FROM vault_entries ORDER BY id').all(), entries);
  assert.deepEqual(f.db.prepare('SELECT * FROM document_associations').all(), documents);
  assert.deepEqual(await fsp.readFile(f.source), sourceBefore);
});

test('an active source account deleted from the vault returns on sync without duplicating other accounts', async t => {
  const f = await fixture(t, 3);
  f.db.prepare('INSERT INTO users (id,email) VALUES (?,?)').run(USER_ID, OWNER_EMAIL);
  await f.service.syncUser(USER_ID, true);
  f.db.prepare('DELETE FROM vault_entries WHERE user_id=? AND homebank_account_id=1').run(USER_ID);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM vault_entries').get().count, 0);
  await f.service.syncUser(USER_ID);
  const recreated = f.db.prepare('SELECT * FROM vault_entries').all();
  assert.equal(recreated.length, 1);
  assert.equal(recreated[0].homebank_account_id, 1);
  assert.equal(recreated[0].title, 'Fixture bank');
  await f.service.syncUser(USER_ID);
  assert.deepEqual(f.db.prepare('SELECT * FROM vault_entries').all(), recreated);
  assert.equal(f.parseCalls(), 1, 'Restoring a missing source identity uses the validated unchanged snapshot');
});

test('another registered user cannot receive accounts from the configured owner source', async t => {
  const f = await fixture(t, 3);
  f.db.prepare('INSERT INTO users (id,email) VALUES (?,?)').run(USER_ID, 'other@example.test');
  f.db.prepare('INSERT INTO users (id,email) VALUES (?,?)').run(USER_ID + 1, OWNER_EMAIL);
  await f.service.syncUser(USER_ID, true);
  await f.service.syncUser(USER_ID);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM vault_entries').get().count, 0);
});

test('an invalid cached account list cannot partially import accounts or rewrite existing entries', async t => {
  const f = await fixture(t, 3);
  f.db.prepare('INSERT INTO users (id,email) VALUES (?,?)').run(USER_ID, OWNER_EMAIL);
  const row = f.db.prepare('SELECT snapshot_encrypted FROM homebank_snapshots').get();
  const badSnapshot = JSON.parse(row.snapshot_encrypted);
  badSnapshot.accounts.push({ ...badSnapshot.accounts[0], name: 'Duplicate source identity' });
  f.db.prepare('UPDATE homebank_snapshots SET snapshot_encrypted=?').run(JSON.stringify(badSnapshot));
  const result = f.service.responseView(await f.service.syncUser(USER_ID));
  assert.match(result.last_error, /Invalid HomeBank account snapshot/);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM vault_entries').get().count, 0);
  assert.equal(f.parseCalls(), 0);
  assert.equal(JSON.stringify(result.snapshot), JSON.stringify(badSnapshot));
});

test('a failed import rolls back the new snapshot, existing reclassification and earlier inserts', async t => {
  const f = await fixture(t, 3);
  f.db.prepare('INSERT INTO users (id,email) VALUES (?,?)').run(USER_ID, OWNER_EMAIL);
  f.db.prepare(`INSERT INTO vault_entries
    (id,user_id,section,title,fields_encrypted,homebank_account_id,updated_at)
    VALUES (1,?,'bank_accounts','Owner title',?,1,'2020-01-01')`)
    .run(USER_ID, vaultCrypto.encrypt(JSON.stringify({ owner_reference: 'Preserve owner fields' })));
  const originalEntries = f.db.prepare('SELECT * FROM vault_entries').all();
  const originalSnapshot = f.db.prepare('SELECT * FROM homebank_snapshots').get();
  f.db.exec(`CREATE TRIGGER reject_source_account BEFORE INSERT ON vault_entries
    WHEN new.homebank_account_id=3 BEGIN SELECT RAISE(ABORT,'Synthetic account failure'); END;`);
  await fsp.writeFile(f.source, xml(250).replace('Savings Accounts', 'Retirement Annuity')
    .replace('</homebank>', '<account key="2" name="New fixture bank" type="1"/>' +
      '<account key="3" name="Failed fixture bank" type="1"/></homebank>'));
  const result = f.service.responseView(await f.service.syncUser(USER_ID, true));
  assert.match(result.last_error, /Synthetic account failure/);
  assert.equal(f.parseCalls(), 1);
  assert.deepEqual(f.db.prepare('SELECT * FROM vault_entries').all(), originalEntries);
  const afterSnapshot = f.db.prepare('SELECT * FROM homebank_snapshots').get();
  for (const key of ['snapshot_encrypted', 'fingerprint', 'source_file', 'source_saved_at', 'synced_at', 'content_hash']) {
    assert.equal(afterSnapshot[key], originalSnapshot[key], `${key} must roll back with the failed import`);
  }
});
