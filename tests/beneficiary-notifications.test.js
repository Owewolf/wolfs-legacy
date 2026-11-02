'use strict';

// Synthetic in-memory data only: these tests never open the deployed vault or
// connect to an email provider.
const { before, beforeEach, after, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { once } = require('node:events');
const Database = require('better-sqlite3');
const express = require('express');
const jwt = require('jsonwebtoken');

process.env.ENCRYPTION_KEY = 'cd'.repeat(32);
process.env.JWT_SECRET = 'fixture-only-beneficiary-notification-secret';
process.env.HOMEBANK_OWNER_EMAIL = 'separate-homebank-owner@example.test';

const OWNER_ID = 801;
const OTHER_ID = 802;
const ACCESS_TOKEN = 'synthetic-access-token-never-emailed';
let db;
let server;
let baseUrl;
let beneficiaryId;

function beneficiary() {
  return db.prepare('SELECT * FROM beneficiaries WHERE id = ?').get(beneficiaryId);
}

function events() {
  return db.prepare('SELECT * FROM notification_outbox ORDER BY id').all();
}

async function request(route, { body = {}, userId = OWNER_ID, status = 200 } = {}) {
  const token = jwt.sign({ id: userId }, process.env.JWT_SECRET, { expiresIn: '5m' });
  const response = await fetch(baseUrl + '/api/beneficiaries' + route, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const result = await response.json();
  assert.equal(response.status, status, `${route}: ${JSON.stringify(result)}`);
  return result;
}

before(async () => {
  db = new Database(':memory:');
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
  const insertUser = db.prepare('INSERT INTO users (id,email,name,password_hash) VALUES (?,?,?,?)');
  insertUser.run(OWNER_ID, 'fixture-owner@example.test', 'Fixture owner', 'fixture-password-hash');
  insertUser.run(OTHER_ID, 'other-owner@example.test', 'Other owner', 'fixture-password-hash');
  db.prepare('INSERT INTO dead_switch_config (user_id) VALUES (?)').run(OWNER_ID);
  db.prepare('INSERT INTO notification_settings (user_id,recipient,verified_at) VALUES (?,?,?)')
    .run(OWNER_ID, 'verified-owner@example.test', new Date().toISOString());

  const app = express();
  app.use(express.json());
  app.use('/api/beneficiaries', require('../server/routes/beneficiaries'));
  app.use((err, req, res, next) => res.status(500).json({ error: 'Fixture transaction failed' }));
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(() => {
  db.exec(`DROP TRIGGER IF EXISTS fixture_outbox_failure;
    DELETE FROM notification_outbox;
    DELETE FROM beneficiaries;
    DELETE FROM audit_log;`);
  db.prepare('UPDATE dead_switch_config SET switch_triggered=0, is_active=0 WHERE user_id=?').run(OWNER_ID);
  db.prepare('UPDATE notification_settings SET verified_at=? WHERE user_id=?').run(new Date().toISOString(), OWNER_ID);
  beneficiaryId = Number(db.prepare(`INSERT INTO beneficiaries
    (user_id,name,email,access_token,token_expires_at,emergency_waiting_days)
    VALUES (?,?,?,?,?,7)`)
    .run(OWNER_ID, 'Fixture beneficiary', 'unverified-beneficiary@example.test',
      require('../server/crypto').hashToken(ACCESS_TOKEN), '2099-01-01T00:00:00.000Z').lastInsertRowid);
});

after(async () => {
  if (server) await new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  if (db?.open) db.close();
});

test('owner transitions queue once and denial leaves existing access intact', async () => {
  assert.equal((await request('/emergency-access', { body: { accessToken: ACCESS_TOKEN } })).status, 'requested');
  const requestedAt = beneficiary().emergency_access_requested_at;
  assert.equal((await request('/emergency-access', { body: { accessToken: ACCESS_TOKEN } })).status, 'already_requested');
  assert.equal(beneficiary().emergency_access_requested_at, requestedAt);

  await request(`/${beneficiaryId}/grant`);
  const grantedAt = beneficiary().access_granted_at;
  await request(`/${beneficiaryId}/grant`);
  assert.equal(beneficiary().access_granted_at, grantedAt);
  assert.equal(beneficiary().emergency_access_requested, 1);

  await request(`/${beneficiaryId}/deny-emergency`);
  await request(`/${beneficiaryId}/deny-emergency`);
  assert.equal(beneficiary().access_granted, 1);
  assert.equal(beneficiary().emergency_access_requested, 0);
  assert.equal(beneficiary().emergency_access_requested_at, null);

  await request(`/${beneficiaryId}/revoke`);
  await request(`/${beneficiaryId}/revoke`);
  assert.equal(beneficiary().access_granted, 0);
  assert.equal(beneficiary().access_granted_at, null);
  assert.deepEqual(events().map(e => e.event_type), [
    'emergency_requested', 'access_granted', 'emergency_denied', 'access_revoked'
  ]);
  assert.ok(events().every(e => e.user_id === OWNER_ID && e.beneficiary_id === beneficiaryId));
  const content = JSON.stringify(events());
  assert.ok(!content.includes(ACCESS_TOKEN));
  assert.ok(!content.includes(require('../server/crypto').hashToken(ACCESS_TOKEN)));
  assert.ok(!content.includes('unverified-beneficiary@example.test'));
});

test('manual revoke still clears an independent pending emergency request', async () => {
  db.prepare(`UPDATE beneficiaries SET emergency_access_requested=1,
    emergency_access_requested_at='2026-01-01T00:00:00.000Z' WHERE id=?`).run(beneficiaryId);
  await request(`/${beneficiaryId}/revoke`);
  await request(`/${beneficiaryId}/revoke`);
  assert.equal(beneficiary().emergency_access_requested, 0);
  assert.equal(beneficiary().emergency_access_requested_at, null);
  assert.equal(beneficiary().access_granted, 0);
  assert.deepEqual(events().map(e => e.event_type), ['emergency_denied']);
});

test('elapsed emergency waiting grants on access and emits only at the actual transition', async () => {
  const requestedAt = new Date(Date.now() - 8 * 86400000).toISOString();
  db.prepare('UPDATE beneficiaries SET emergency_access_requested=1, emergency_access_requested_at=? WHERE id=?')
    .run(requestedAt, beneficiaryId);
  assert.equal(events().length, 0);
  for (let i = 0; i < 2; i++) {
    assert.equal((await request('/access', { body: { accessToken: ACCESS_TOKEN } })).status, 'granted');
  }
  assert.equal(beneficiary().access_granted, 1);
  assert.equal(beneficiary().emergency_access_requested, 1);
  assert.equal(beneficiary().emergency_access_requested_at, requestedAt);
  assert.deepEqual(events().map(e => e.event_type), ['emergency_granted']);
});

test('pending emergency waiting does not grant early or queue a grant', async () => {
  await request('/emergency-access', { body: { accessToken: ACCESS_TOKEN } });
  assert.equal((await request('/access', { body: { accessToken: ACCESS_TOKEN } })).status, 'waiting');
  assert.equal(beneficiary().access_granted, 0);
  assert.deepEqual(events().map(e => e.event_type), ['emergency_requested']);
});

test('legacy SQLite request timestamps keep their UTC meaning on a South Africa host', async () => {
  const previousTimezone = process.env.TZ;
  process.env.TZ = 'Africa/Johannesburg';
  try {
    // The seven-day wait still has an hour left. Parsing SQLite UTC as host
    // local time would incorrectly release this request an hour early.
    const requestedAt = new Date(Date.now() - 7 * 86400000 + 3600000).toISOString().slice(0, 19).replace('T', ' ');
    db.prepare('UPDATE beneficiaries SET emergency_access_requested=1, emergency_access_requested_at=? WHERE id=?')
      .run(requestedAt, beneficiaryId);
    assert.equal((await request('/access', { body: { accessToken: ACCESS_TOKEN } })).status, 'waiting');
    assert.equal(beneficiary().access_granted, 0);
    assert.equal(events().length, 0);
  } finally {
    if (previousTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = previousTimezone;
  }
});

test('triggered switch grants on access and preserves the baseline regrant after manual revoke', async () => {
  db.prepare('UPDATE dead_switch_config SET switch_triggered=1 WHERE user_id=?').run(OWNER_ID);
  for (let i = 0; i < 2; i++) {
    assert.equal((await request('/access', { body: { accessToken: ACCESS_TOKEN } })).status, 'granted');
  }
  await request(`/${beneficiaryId}/revoke`);
  assert.equal((await request('/access', { body: { accessToken: ACCESS_TOKEN } })).status, 'granted');
  assert.deepEqual(events().map(e => e.event_type), ['deadswitch_granted', 'access_revoked', 'deadswitch_granted']);
});

test('foreign or absent beneficiaries return 404 without mutation or notification', async () => {
  for (const action of ['grant', 'revoke', 'deny-emergency']) {
    await request(`/${beneficiaryId}/${action}`, { userId: OTHER_ID, status: 404 });
    await request(`/999999/${action}`, { status: 404 });
  }
  assert.equal(beneficiary().access_granted, 0);
  assert.equal(beneficiary().emergency_access_requested, 0);
  assert.equal(events().length, 0);
});

test('unverified notification settings never send to a beneficiary or block access changes', async () => {
  db.prepare('UPDATE notification_settings SET verified_at=NULL WHERE user_id=?').run(OWNER_ID);
  await request(`/${beneficiaryId}/grant`);
  assert.equal(beneficiary().access_granted, 1);
  assert.equal(events().length, 0);
  assert.ok(db.prepare('SELECT COUNT(*) AS n FROM audit_log').get().n > 0);
});

test('notification failure rolls back the emergency request and manual grant', async () => {
  db.exec(`CREATE TRIGGER fixture_outbox_failure BEFORE INSERT ON notification_outbox
    BEGIN SELECT RAISE(ABORT, 'fixture queue unavailable'); END;`);
  await request('/emergency-access', { body: { accessToken: ACCESS_TOKEN }, status: 500 });
  assert.equal(beneficiary().emergency_access_requested, 0);
  await request(`/${beneficiaryId}/grant`, { status: 500 });
  assert.equal(beneficiary().access_granted, 0);
  assert.equal(events().length, 0);
});

test('notification failure rolls back automatic emergency and switch grants', async () => {
  db.prepare('UPDATE beneficiaries SET emergency_access_requested=1, emergency_access_requested_at=? WHERE id=?')
    .run(new Date(Date.now() - 8 * 86400000).toISOString(), beneficiaryId);
  db.exec(`CREATE TRIGGER fixture_outbox_failure BEFORE INSERT ON notification_outbox
    BEGIN SELECT RAISE(ABORT, 'fixture queue unavailable'); END;`);
  await request('/access', { body: { accessToken: ACCESS_TOKEN }, status: 500 });
  assert.equal(beneficiary().access_granted, 0);
  db.prepare('UPDATE beneficiaries SET emergency_access_requested=0, emergency_access_requested_at=NULL WHERE id=?').run(beneficiaryId);
  db.prepare('UPDATE dead_switch_config SET switch_triggered=1 WHERE user_id=?').run(OWNER_ID);
  await request('/access', { body: { accessToken: ACCESS_TOKEN }, status: 500 });
  assert.equal(beneficiary().access_granted, 0);
  assert.equal(events().length, 0);
});

test('notification failure rolls back denial and revocation including emergency state', async () => {
  const requestedAt = new Date().toISOString();
  db.prepare(`UPDATE beneficiaries SET access_granted=1, access_granted_at=?,
    emergency_access_requested=1, emergency_access_requested_at=? WHERE id=?`)
    .run(requestedAt, requestedAt, beneficiaryId);
  db.exec(`CREATE TRIGGER fixture_outbox_failure BEFORE INSERT ON notification_outbox
    BEGIN SELECT RAISE(ABORT, 'fixture queue unavailable'); END;`);
  for (const action of ['deny-emergency', 'revoke']) {
    await request(`/${beneficiaryId}/${action}`, { status: 500 });
    assert.equal(beneficiary().access_granted, 1);
    assert.equal(beneficiary().access_granted_at, requestedAt);
    assert.equal(beneficiary().emergency_access_requested, 1);
    assert.equal(beneficiary().emergency_access_requested_at, requestedAt);
  }
  assert.equal(events().length, 0);
});
