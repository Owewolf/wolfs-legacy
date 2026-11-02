'use strict';

// The real router and SQLite schema run only against synthetic in-memory data.
const { before, beforeEach, after, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Database = require('better-sqlite3');
const jwt = require('jsonwebtoken');

process.env.ENCRYPTION_KEY = 'c5'.repeat(32);
process.env.JWT_SECRET = 'synthetic-beneficiary-delete-secret';
process.env.NOTIFICATIONS_ENABLED = 'false';
process.env.HOMEBANK_OWNER_EMAIL = 'separate-homebank-owner@example.test';

const OWNER = 931, OTHER = 932;
let db, router, beneficiaryId, otherBeneficiaryId;

function request(id, { owner = OWNER, mfa = true } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (owner !== null) headers.authorization = 'Bearer ' + jwt.sign(
      { id: owner, ...(mfa ? { mfa: 'sms_otp' } : {}) }, process.env.JWT_SECRET, { expiresIn: '5m' });
    const req = { method: 'DELETE', url: '/' + id, headers,
      ip: '127.0.0.1', app: { locals: { getDb: () => db } } };
    const res = {
      statusCode: 200,
      status(value) { this.statusCode = value; return this; },
      json(data) { resolve({ status: this.statusCode, data }); return this; }
    };
    router.handle(req, res, error => error ? resolve({ status: 500 }) : reject(new Error('No matching synthetic route')));
  });
}

function queue(status, { userId = OWNER, beneficiary = beneficiaryId, suffix = '' } = {}) {
  const at = '2026-11-02T10:00:00.000Z';
  return Number(db.prepare(`INSERT INTO notification_outbox
    (event_type,user_id,beneficiary_id,idempotency_key,schedule_at,status,next_attempt_at,data_json,created_at,updated_at)
    VALUES ('access_granted',?,?,?,?,?,?,?,?,?)`)
    .run(userId, beneficiary, `delete:${userId}:${beneficiary}:${status}:${suffix}`, at, status,
      status === 'failed' ? at : null,
      JSON.stringify({ beneficiaryName: 'Synthetic beneficiary', eventAt: at, grantedAt: at, accessGranted: true }),
      at, at).lastInsertRowid);
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
  insert.run(OWNER, 'delete-owner@example.test', 'Synthetic owner', 'synthetic-password-hash', 1);
  insert.run(OTHER, 'delete-other@example.test', 'Synthetic other', 'synthetic-password-hash', 0);
  db.prepare('INSERT INTO notification_settings(user_id,recipient,verified_at) VALUES(?,?,?)')
    .run(OWNER, 'verified-owner@example.test', '2026-11-01T10:00:00.000Z');
  router = require('../server/routes/beneficiaries');
});

beforeEach(() => {
  db.exec(`DROP TRIGGER IF EXISTS fixture_delete_cancel_failure;
    DELETE FROM legacy_contents; DELETE FROM notification_outbox; DELETE FROM beneficiaries;
    DELETE FROM vault_entries; DELETE FROM audit_log;`);
  const insert = db.prepare('INSERT INTO beneficiaries(user_id,name,access_token) VALUES(?,?,?)');
  beneficiaryId = Number(insert.run(OWNER, 'Removed beneficiary', 'synthetic-removed-token').lastInsertRowid);
  otherBeneficiaryId = Number(insert.run(OWNER, 'Retained beneficiary', 'synthetic-retained-token').lastInsertRowid);
});

after(() => { if (db?.open) db.close(); });

test('deleting a beneficiary cancels only their owner-scoped unsent jobs and preserves delivery history', async () => {
  const pending = ['queued', 'retried', 'failed'].map(status => queue(status));
  const retained = ['sending', 'sent_to_server', 'delivered', 'dead_letter', 'cancelled', 'uncertain']
    .map(status => queue(status));
  retained.push(queue('queued', { beneficiary: otherBeneficiaryId }));
  retained.push(queue('queued', { beneficiary: null }));
  // Even malformed cross-owner links must not allow another owner's jobs to change.
  retained.push(queue('queued', { userId: OTHER }));
  const select = db.prepare('SELECT * FROM notification_outbox WHERE id=?');
  const beforeRetained = retained.map(id => select.get(id));
  const wish = require('../server/legacy-content').save(db, OWNER, {
    type: 'instruction', title: 'Keep this existing wish', body_markdown: 'Owner content', beneficiary_ids: [beneficiaryId]
  });
  const wishBefore = db.prepare('SELECT * FROM legacy_contents WHERE id=?').get(wish.id);
  db.prepare('INSERT INTO vault_entries(user_id,section,title,fields_encrypted) VALUES(?,?,?,?)')
    .run(OWNER, 'contacts', 'Keep this contact', 'synthetic-fields');

  assert.deepEqual(await request(beneficiaryId), { status: 200, data: { success: true } });
  assert.equal(db.prepare('SELECT id FROM beneficiaries WHERE id=?').get(beneficiaryId), undefined);
  assert.ok(db.prepare('SELECT id FROM beneficiaries WHERE id=?').get(otherBeneficiaryId));
  for (const id of pending) {
    assert.equal(select.get(id).status, 'cancelled');
    assert.equal(select.get(id).next_attempt_at, null);
  }
  assert.deepEqual(retained.map(id => select.get(id)), beforeRetained);
  assert.deepEqual(db.prepare('SELECT * FROM legacy_contents WHERE id=?').get(wish.id), wishBefore);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM legacy_content_beneficiaries WHERE beneficiary_id=?').get(beneficiaryId).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM users').get().n, 2);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM vault_entries').get().n, 1);
});

test('deleted beneficiary work cannot be sent by the next notification worker tick', async () => {
  const removedJob = queue('queued');
  const retainedJob = queue('queued', { beneficiary: otherBeneficiaryId });
  assert.equal((await request(beneficiaryId)).status, 200);
  const deliveries = [];
  const worker = require('../server/notifications/worker').createNotificationWorker({
    db, env: { NOTIFICATIONS_ENABLED: 'true', NOTIFICATION_SECRET: 'd6'.repeat(32), SMTP_FROM: 'sender@example.test' },
    now: () => new Date('2026-11-02T11:00:00.000Z'),
    smtp: { async sendMail(message) { deliveries.push(message); return { status: 'sent_to_server', acceptedCount: 1, rejectedCount: 0 }; } },
    imap: { async poll() {} }
  });
  try { await worker.tick(); }
  finally { worker.stop(); }
  assert.equal(deliveries.length, 1);
  assert.equal(db.prepare('SELECT status FROM notification_outbox WHERE id=?').get(removedJob).status, 'cancelled');
  assert.equal(db.prepare('SELECT status FROM notification_outbox WHERE id=?').get(retainedJob).status, 'sent_to_server');
});

test('beneficiary deletion and pending-job cancellation roll back together if cancellation fails', async () => {
  const id = queue('queued');
  db.exec(`CREATE TRIGGER fixture_delete_cancel_failure BEFORE UPDATE OF status ON notification_outbox
    BEGIN SELECT RAISE(ABORT,'Synthetic cancellation failure'); END;`);
  assert.equal((await request(beneficiaryId)).status, 500);
  assert.ok(db.prepare('SELECT id FROM beneficiaries WHERE id=?').get(beneficiaryId));
  assert.equal(db.prepare('SELECT status FROM notification_outbox WHERE id=?').get(id).status, 'queued');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='remove_beneficiary'").get().n, 0);
});

test('unauthenticated, incomplete MFA, other-owner and missing-beneficiary deletes leave jobs untouched', async () => {
  queue('queued');
  const before = db.prepare('SELECT * FROM notification_outbox').all();
  assert.equal((await request(beneficiaryId, { owner: null })).status, 401);
  assert.equal((await request(beneficiaryId, { mfa: false })).status, 403);
  assert.equal((await request(beneficiaryId, { owner: OTHER })).status, 404);
  assert.equal((await request(beneficiaryId + 10000)).status, 404);
  assert.ok(db.prepare('SELECT id FROM beneficiaries WHERE id=?').get(beneficiaryId));
  assert.deepEqual(db.prepare('SELECT * FROM notification_outbox').all(), before);
});
