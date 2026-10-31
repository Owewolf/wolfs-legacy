'use strict';

// Exercise the real routes and schema against synthetic in-memory records.
// The database constructor is replaced before getDb() can open a vault file.
const { before, beforeEach, after, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { once } = require('node:events');
const Database = require('better-sqlite3');
const express = require('express');
const jwt = require('jsonwebtoken');

process.env.ENCRYPTION_KEY = 'a3'.repeat(32);
process.env.JWT_SECRET = 'synthetic-beneficiary-final-wishes-secret';
process.env.NOTIFICATIONS_ENABLED = 'false';
process.env.HOMEBANK_OWNER_EMAIL = 'separate-homebank-owner@example.test';

const OWNER = 811, OTHER = 812;
const { decrypt, hashToken } = require('../server/crypto');
const legacy = require('../server/legacy-content');
let db, server, base;

async function request({ body = { name: '  Synthetic beneficiary  ' }, owner = OWNER, method = 'POST' } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (owner !== null) headers.Authorization = 'Bearer ' + jwt.sign({ id: owner }, process.env.JWT_SECRET, { expiresIn: '5m' });
  const response = await fetch(base + '/api/beneficiaries', {
    method, headers, ...(method !== 'GET' ? { body: JSON.stringify(body) } : {})
  });
  return { status: response.status, data: await response.json() };
}

function count(table) { return db.prepare('SELECT COUNT(*) AS n FROM ' + table).get().n; }

before(async () => {
  db = new Database(':memory:');
  const databaseModule = require.cache[require.resolve('better-sqlite3')];
  const originalConstructor = databaseModule.exports;
  databaseModule.exports = function FixtureDatabase(filename) {
    assert.equal(filename, path.resolve(__dirname, '../data/vault.db'));
    return db;
  };
  try { assert.equal(require('../server/db').getDb(), db); }
  finally { databaseModule.exports = originalConstructor; }
  const insert = db.prepare('INSERT INTO users(id,email,name,password_hash) VALUES(?,?,?,?)');
  insert.run(OWNER, 'synthetic-wishes-owner@example.test', 'Synthetic owner', 'synthetic-hash');
  insert.run(OTHER, 'synthetic-wishes-other@example.test', 'Synthetic other', 'synthetic-hash');
  const app = express();
  app.use(express.json());
  app.use('/api/beneficiaries', require('../server/routes/beneficiaries'));
  app.use((err, req, res, next) => res.status(500).json({ error: 'Synthetic transaction failed' }));
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(() => {
  db.exec(`DROP TRIGGER IF EXISTS fixture_wish_insert_failure;
    DROP TRIGGER IF EXISTS fixture_wish_audit_failure;
    DROP TRIGGER IF EXISTS fixture_beneficiary_audit_failure;
    DELETE FROM legacy_contents;
    DELETE FROM beneficiaries;
    DELETE FROM notification_outbox;
    DELETE FROM audit_log;`);
});

after(async () => {
  if (server) await new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  if (db?.open) db.close();
});

test('adding a beneficiary creates one encrypted private draft assigned to that beneficiary', async () => {
  const result = await request({ body: {
    name: '  Synthetic beneficiary  ', email: 'synthetic-recipient@example.test',
    phone: '000', relationship: 'Friend', emergency_waiting_days: 9
  } });
  assert.equal(result.status, 200);
  const created = result.data;
  assert.equal(created.name, 'Synthetic beneficiary');
  assert.equal(created.emergency_waiting_days, 9);
  assert.equal(created.final_wish_id, created.final_wish.id);
  assert.equal(count('beneficiaries'), 1);
  assert.equal(count('legacy_contents'), 1);
  const beneficiary = db.prepare('SELECT * FROM beneficiaries WHERE id=?').get(created.id);
  assert.equal(beneficiary.access_token, hashToken(created.accessToken));
  assert.equal(beneficiary.access_granted, 0);
  assert.equal(beneficiary.emergency_access_requested, 0);
  const row = db.prepare('SELECT * FROM legacy_contents WHERE id=?').get(created.final_wish_id);
  assert.equal(row.user_id, OWNER);
  assert.equal(row.type, 'instruction');
  assert.equal(row.status, 'draft');
  assert.equal(row.release_policy, 'owner_only');
  assert.equal(row.final_wishes_entry_id, null);
  assert.equal(row.review_enabled, 0);
  assert.ok(!row.payload_encrypted.includes('Synthetic beneficiary'));
  const payload = JSON.parse(decrypt(row.payload_encrypted));
  assert.equal(payload.title, 'Final Wishes for Synthetic beneficiary');
  assert.equal(payload.body_markdown, '');
  assert.deepEqual(payload.metadata.final_wishes, { category: '', details: '', contact_person: '', contact_phone: '', notes: '' });
  assert.deepEqual(payload.metadata.origin, { type: 'beneficiary', beneficiary_id: created.id });
  const mappings = db.prepare('SELECT * FROM legacy_content_beneficiaries').all();
  assert.equal(mappings.length, 1);
  assert.equal(mappings[0].content_id, row.id);
  assert.equal(mappings[0].beneficiary_id, created.id);
  assert.equal(mappings[0].released_at, null);
  assert.equal(mappings[0].release_scope, null);
  assert.equal(count('vault_entries'), 0);
  assert.equal(count('notification_outbox'), 0);
  assert.deepEqual(db.prepare('SELECT action FROM audit_log ORDER BY id').all().map(x => x.action), ['legacy_created', 'add_beneficiary']);

  // Even existing general access cannot expose an unprepared owner-only wish.
  db.prepare('UPDATE beneficiaries SET access_granted=1 WHERE id=?').run(created.id);
  const authorised = db.prepare('SELECT * FROM beneficiaries WHERE id=?').get(created.id);
  assert.equal(legacy.canRead(db, authorised, row), false);
  assert.deepEqual(legacy.list(db, OWNER, {}, authorised), []);
});

test('automatic wishes belong to the authenticated owner and are absent for other owners', async () => {
  const first = await request();
  const second = await request({ owner: OTHER, body: { name: 'Other owner beneficiary', user_id: OWNER } });
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.deepEqual(legacy.list(db, OWNER).map(item => item.id), [first.data.final_wish_id]);
  assert.deepEqual(legacy.list(db, OTHER).map(item => item.id), [second.data.final_wish_id]);
  assert.equal(db.prepare('SELECT user_id FROM beneficiaries WHERE id=?').get(second.data.id).user_id, OTHER);
});

test('listing existing beneficiaries does not backfill or duplicate automatic wishes', async () => {
  db.prepare('INSERT INTO beneficiaries(user_id,name) VALUES(?,?)').run(OWNER, 'Existing beneficiary');
  const created = await request();
  assert.equal(created.status, 200);
  for (let attempt = 0; attempt < 2; attempt++) {
    const listed = await request({ method: 'GET' });
    assert.equal(listed.status, 200);
    assert.equal(listed.data.length, 2);
    assert.equal(count('legacy_contents'), 1);
  }
});

test('invalid or unauthenticated additions do not create a beneficiary or wish', async () => {
  assert.equal((await request({ owner: null })).status, 401);
  assert.equal((await request({ body: { name: '   ' } })).status, 400);
  assert.equal((await request({ body: { name: 'Synthetic', email: 'invalid' } })).status, 400);
  assert.equal((await request({ body: { name: 'Synthetic', emergency_waiting_days: 91 } })).status, 400);
  assert.equal(count('beneficiaries'), 0);
  assert.equal(count('legacy_contents'), 0);
  assert.equal(count('audit_log'), 0);
});

for (const failure of [
  { name: 'wish creation', trigger: 'fixture_wish_insert_failure', table: 'legacy_contents', condition: '' },
  { name: 'wish audit', trigger: 'fixture_wish_audit_failure', table: 'audit_log', condition: "WHEN NEW.action='legacy_created'" },
  { name: 'beneficiary audit', trigger: 'fixture_beneficiary_audit_failure', table: 'audit_log', condition: "WHEN NEW.action='add_beneficiary'" }
]) {
  test(`${failure.name} failure rolls back the beneficiary, wish, mapping and all creation events`, async () => {
    const priorEvents = count('legacy_release_events');
    db.exec(`CREATE TRIGGER ${failure.trigger} BEFORE INSERT ON ${failure.table} ${failure.condition}
      BEGIN SELECT RAISE(ABORT, 'synthetic write failure'); END;`);
    assert.equal((await request()).status, 500);
    for (const table of ['beneficiaries', 'legacy_contents', 'legacy_content_beneficiaries', 'audit_log']) {
      assert.equal(count(table), 0, table + ' remains unchanged after a failed addition');
    }
    assert.equal(count('legacy_release_events'), priorEvents);
    db.exec('DROP TRIGGER ' + failure.trigger);
    const retry = await request();
    assert.equal(retry.status, 200);
    assert.equal(count('beneficiaries'), 1);
    assert.equal(count('legacy_contents'), 1);
    assert.equal(count('legacy_content_beneficiaries'), 1);
  });
}
