'use strict';

// Run the real beneficiary router and auth middleware against an in-memory
// schema. No listening socket or on-disk vault is used by these tests.
const { before, beforeEach, after, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Database = require('better-sqlite3');
const jwt = require('jsonwebtoken');

process.env.ENCRYPTION_KEY = 'b4'.repeat(32);
process.env.JWT_SECRET = 'synthetic-beneficiary-edit-secret';
process.env.NOTIFICATIONS_ENABLED = 'false';
process.env.HOMEBANK_OWNER_EMAIL = 'separate-homebank-owner@example.test';

const OWNER = 921, OTHER = 922;
const legacy = require('../server/legacy-content');
let db, router;

function request(id, { method = 'PUT', owner = OWNER, mfa = true, body = {
  name: '  Updated beneficiary  ', email: 'updated@example.test',
  phone: '+27821234567', relationship: 'Sibling', emergency_waiting_days: 12
} } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (owner !== null) headers.authorization = 'Bearer ' + jwt.sign(
      { id: owner, ...(mfa ? { mfa: 'sms_otp' } : {}) }, process.env.JWT_SECRET, { expiresIn: '5m' });
    const req = { method, url: id === null ? '/' : '/' + id, headers, body,
      ip: '127.0.0.1', app: { locals: { getDb: () => db } } };
    const res = {
      statusCode: 200,
      status(value) { this.statusCode = value; return this; },
      json(data) { resolve({ status: this.statusCode, data }); return this; }
    };
    router.handle(req, res, error => reject(error || new Error('No matching synthetic route')));
  });
}

function protectedSnapshot() {
  return Object.fromEntries([
    'legacy_contents', 'legacy_content_beneficiaries', 'legacy_content_versions',
    'legacy_content_reviews', 'legacy_content_attachments', 'legacy_content_links',
    'legacy_content_acknowledgements', 'legacy_release_events'
  ].map(table => [table, db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all()]));
}

async function createEditedWish() {
  const result = await request(null, { method: 'POST', body: {
    name: 'Original beneficiary', email: 'original@example.test', phone: '+27820000000',
    relationship: 'Trusted Friend', emergency_waiting_days: 8
  } });
  assert.equal(result.status, 200);
  const wish = legacy.save(db, OWNER, {
    title: 'Owner-edited personal wish', body_markdown: 'Keep this private message exactly as written.'
  }, result.data.final_wish_id);
  assert.equal(wish.revision, 2);
  return result.data;
}

before(() => {
  db = new Database(':memory:');
  const databaseModule = require.cache[require.resolve('better-sqlite3')];
  const originalConstructor = databaseModule.exports;
  databaseModule.exports = function FixtureDatabase(filename) {
    assert.equal(filename, path.resolve(__dirname, '../data/vault.db'));
    return db;
  };
  try { assert.equal(require('../server/db').getDb(), db); }
  finally { databaseModule.exports = originalConstructor; }
  const insert = db.prepare('INSERT INTO users(id,email,name,password_hash,sms_2fa_enabled) VALUES(?,?,?,?,?)');
  insert.run(OWNER, 'edit-owner@example.test', 'Synthetic owner', 'synthetic-password-hash', 1);
  insert.run(OTHER, 'edit-other@example.test', 'Synthetic other', 'synthetic-password-hash', 0);
  router = require('../server/routes/beneficiaries');
});

beforeEach(() => {
  db.exec('DELETE FROM legacy_contents; DELETE FROM beneficiaries; DELETE FROM audit_log; DELETE FROM notification_outbox;');
});

after(() => { if (db?.open) db.close(); });

test('beneficiary PUT edits phone and owner fields while preserving the edited encrypted wish, token and access state', async () => {
  const created = await createEditedWish();
  db.prepare(`UPDATE beneficiaries SET access_granted=1, access_granted_at='2026-10-31T09:00:00Z',
    emergency_access_requested=1, emergency_access_requested_at='2026-10-30T09:00:00Z' WHERE id=?`).run(created.id);
  const beforeBeneficiary = db.prepare('SELECT * FROM beneficiaries WHERE id=?').get(created.id);
  const beforeProtected = protectedSnapshot();

  const result = await request(created.id);
  assert.equal(result.status, 200);
  assert.equal(result.data.name, 'Updated beneficiary');
  assert.equal(result.data.email, 'updated@example.test');
  assert.equal(result.data.phone, '+27821234567');
  assert.equal(result.data.relationship, 'Sibling');
  assert.equal(result.data.emergency_waiting_days, 12);
  assert.equal(Object.hasOwn(result.data, 'accessToken'), false);
  assert.equal(Object.hasOwn(result.data, 'access_token'), false);
  assert.equal(Object.hasOwn(result.data, 'payload_encrypted'), false);

  const afterBeneficiary = db.prepare('SELECT * FROM beneficiaries WHERE id=?').get(created.id);
  for (const field of ['user_id', 'access_token', 'token_expires_at', 'created_at', 'access_granted',
    'access_granted_at', 'emergency_access_requested', 'emergency_access_requested_at']) {
    assert.equal(afterBeneficiary[field], beforeBeneficiary[field], field + ' is retained');
  }
  assert.deepEqual(protectedSnapshot(), beforeProtected);
  const wish = legacy.list(db, OWNER)[0];
  assert.equal(wish.id, created.final_wish_id);
  assert.equal(wish.title, 'Owner-edited personal wish');
  assert.equal(wish.body_markdown, 'Keep this private message exactly as written.');
  assert.equal(wish.beneficiaries[0].name, 'Updated beneficiary');
  assert.equal(wish.status, 'draft');
  assert.equal(wish.release_policy, 'owner_only');
  assert.deepEqual(legacy.list(db, OWNER, {}, afterBeneficiary), []);
  assert.deepEqual(db.prepare("SELECT user_id,target_id,detail FROM audit_log WHERE action='edit_beneficiary'").all(),
    [{ user_id: OWNER, target_id: created.id, detail: 'Updated beneficiary' }]);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM notification_outbox').get().n, 0);
});

test('repeated beneficiary edits retain one existing wish and allow optional phone and contact fields to be cleared', async () => {
  const created = await createEditedWish();
  const beforeProtected = protectedSnapshot();
  assert.equal((await request(created.id)).status, 200);
  const result = await request(created.id, { body: {
    name: 'Updated beneficiary', email: '', phone: '', relationship: '', emergency_waiting_days: 3
  } });
  assert.equal(result.status, 200);
  assert.equal(result.data.email, null);
  assert.equal(result.data.phone, null);
  assert.equal(result.data.relationship, null);
  assert.equal(result.data.emergency_waiting_days, 3);
  assert.deepEqual(protectedSnapshot(), beforeProtected);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM legacy_contents').get().n, 1);
});

test('beneficiary edits reject unverified SMS sessions, other owners and invalid input without changing either record', async () => {
  const created = await createEditedWish();
  const beforeBeneficiary = db.prepare('SELECT * FROM beneficiaries WHERE id=?').get(created.id);
  const beforeProtected = protectedSnapshot();
  assert.equal((await request(created.id, { owner: null })).status, 401);
  assert.equal((await request(created.id, { mfa: false })).status, 403);
  assert.equal((await request(created.id, { owner: OTHER, mfa: false })).status, 404);
  assert.equal((await request(created.id, { body: { name: ' ' } })).status, 400);
  assert.equal((await request(created.id, { body: { name: 'Valid', email: 'invalid' } })).status, 400);
  assert.equal((await request(created.id, { body: { name: 'Valid', emergency_waiting_days: 91 } })).status, 400);
  assert.deepEqual(db.prepare('SELECT * FROM beneficiaries WHERE id=?').get(created.id), beforeBeneficiary);
  assert.deepEqual(protectedSnapshot(), beforeProtected);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='edit_beneficiary'").get().n, 0);
});
