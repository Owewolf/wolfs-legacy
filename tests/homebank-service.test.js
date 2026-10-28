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

const SERVICE_PATH = path.resolve(__dirname, '../server/homebank-service.js');
const SERVICE_SOURCE = fs.readFileSync(SERVICE_PATH, 'utf8');
const requireFromService = createRequire(SERVICE_PATH);
const USER_ID = 901;
const xml = initial => `<homebank v="1.6"><account key="1" type="1" name="Fixture bank"
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
  )`);
  let parseCalls = 0;
  const isolatedModule = { exports: {} };
  const context = {
    module: isolatedModule, exports: isolatedModule.exports, __dirname: path.dirname(SERVICE_PATH),
    process: { env: { ...process.env, HOMEBANK_ALLOWED_ROOT: directory, HOMEBANK_DIRECTORY: directory } },
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
  const snapshot = { exported_date: today(), accounts: [{ id: 1, name: 'Cached fixture' }] };
  if (schemaVersion !== undefined) snapshot.snapshot_schema_version = schemaVersion;
  db.prepare(`INSERT INTO homebank_snapshots
    (user_id, config_encrypted, snapshot_encrypted, fingerprint, source_file)
    VALUES (?, ?, ?, ?, ?)`)
    .run(USER_ID, JSON.stringify({ directory, selectedFile: 'fixture.xhb', auto: true }),
      JSON.stringify(snapshot), file.fingerprint, file.name);
  return { db, source, service, parseCalls: () => parseCalls };
}

for (const version of [undefined, 1]) {
  test(`an unchanged source is reparsed for ${version === undefined ? 'unversioned' : 'older'} cached snapshots`, async t => {
    const f = await fixture(t, version);
    const originalSource = await fsp.readFile(f.source);
    const refreshed = f.service.responseView(await f.service.syncUser(USER_ID));
    assert.equal(f.parseCalls(), 1);
    assert.equal(refreshed.last_error, null);
    assert.equal(refreshed.snapshot.snapshot_schema_version, 2);
    assert.equal(refreshed.snapshot.accounts[0].bank_name, 'Fixture institution');
    assert.equal(refreshed.snapshot.accounts[0].account_number, '00012345');
    assert.deepEqual(await fsp.readFile(f.source), originalSource);
  });
}

test('current version snapshots keep the unchanged-source cache', async t => {
  const f = await fixture(t, 2);
  const before = f.db.prepare('SELECT snapshot_encrypted FROM homebank_snapshots').get().snapshot_encrypted;
  const result = await f.service.syncUser(USER_ID);
  assert.equal(f.parseCalls(), 0);
  assert.equal(result.snapshot_encrypted, before);
});

test('a saved source updates ledger amounts and metadata on the next automatic sync', async t => {
  const f = await fixture(t, 2);
  await fsp.writeFile(f.source, xml(250).replace('Fixture institution', 'Updated fixture institution'));
  const changed = f.service.responseView(await f.service.syncUser(USER_ID));
  assert.equal(f.parseCalls(), 1);
  assert.equal(changed.last_error, null);
  assert.equal(changed.snapshot.accounts[0].today, 250);
  assert.equal(changed.snapshot.accounts[0].bank_name, 'Updated fixture institution');
  await f.service.syncUser(USER_ID);
  assert.equal(f.parseCalls(), 1, 'The freshly parsed source should be cached');
});
