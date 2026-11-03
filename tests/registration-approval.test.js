'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { initSmsOtpSchema } = require('../server/sms-otp');
const { initRegistrationApprovalSchema, createRegistrationApprovalService, INVITATION_TTL_MS } = require('../server/registration-approval');

function fixture(options = {}) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL,password_hash TEXT NOT NULL,
    sms_2fa_phone_e164 TEXT,sms_2fa_enabled INTEGER DEFAULT 0,sms_2fa_enrolled_at TEXT);
    CREATE TABLE audit_log(id INTEGER PRIMARY KEY,user_id INTEGER,action TEXT,target_type TEXT,target_id INTEGER,detail TEXT,ip_address TEXT);
    CREATE TABLE vault_entries(user_id INTEGER,section TEXT,fields_encrypted TEXT);
    CREATE TABLE beneficiaries(user_id INTEGER,name TEXT);
    INSERT INTO users VALUES(1,'owner@example.test','Owner','preserved-hash','+27821230001',1,'2026-01-01');
    INSERT INTO vault_entries VALUES(1,'personal','{"mobile_phone":"+27821230001"}');
    INSERT INTO beneficiaries VALUES(1,'Preserved beneficiary');`);
  initSmsOtpSchema(db);
  initRegistrationApprovalSchema(db);
  let clock = Date.parse('2026-11-03T10:00:00.000Z');
  const env = { ACCOUNT_APPROVAL_OWNER_USER_ID: '1', ACCOUNT_APPROVAL_OWNER_SMS_E164: '+27821230001',
    OTP_HASH_KEY: 'k'.repeat(64), APP_BASE_URL: 'https://legacy.example.test', SMS_DEFAULT_COUNTRY_CODE: '27', ...options.env };
  const sent = [];
  const sender = { configured: true, async sendOtp(message) { sent.push(message); if (options.failSms) throw new Error('synthetic provider error'); }, ...options.sender };
  const service = () => createRegistrationApprovalService({ db, env, now: () => clock, smsSender: sender, decryptFields: value => value });
  const actor = { id: 1, mfa: 'sms_otp', auth_version: 0 };
  const applicant = { name: 'Alex Example', email: 'Alex@Example.test', phone: '082 123 4567', ipAddress: '192.0.2.1' };
  return { db, env, sender, sent, service, actor, applicant, advance: delta => { clock += delta; }, close: () => db.close() };
}
async function approve(f) {
  const request = await f.service().requestAccess(f.applicant);
  const approved = f.service().decide({ requestId: request.request_id, actor: f.actor, decision: 'approve', confirmed: true });
  assert.equal(approved.ok, true);
  return { request, approved };
}

test('migration is additive, repeatable and preserves existing credentials, SMS, vault and beneficiary data', () => {
  const f = fixture();
  try {
    initRegistrationApprovalSchema(f.db);
    const owner = f.db.prepare('SELECT * FROM users WHERE id=1').get();
    assert.equal(owner.account_status, 'active');
    assert.equal(owner.auth_version, 0);
    assert.equal(owner.password_hash, 'preserved-hash');
    assert.equal(owner.sms_2fa_enabled, 1);
    assert.equal(owner.sms_2fa_phone_e164, '+27821230001');
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM vault_entries').get().n, 1);
    assert.equal(f.db.prepare('SELECT name FROM beneficiaries').get().name, 'Preserved beneficiary');
  } finally { f.close(); }
});

test('public request creates no account, vault or applicant OTP; concurrent duplicates have private decoys and no SMS flood', async () => {
  const f = fixture();
  try {
    const requests = await Promise.all([f.service().requestAccess(f.applicant), f.service().requestAccess(f.applicant)]);
    assert.equal(requests.every(response => response.ok), true);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM users').get().n, 1);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM registration_requests').get().n, 1);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM vault_entries').get().n, 1);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM sms_otp_challenges').get().n, 0);
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0].to, '+27821230001');
    assert.match(f.sent[0].message, /Approve or Reject after signing in/);
    assert.match(f.sent[0].message, /#admin\/registration-requests\//);
    assert.notEqual(requests[0].request_id, requests[1].request_id);
    assert.notEqual(requests[0].status_secret, requests[1].status_secret);
    const row = f.db.prepare('SELECT * FROM registration_requests').get();
    assert.notEqual(row.status_secret_hash, requests[0].status_secret);
    assert.equal(row.email, 'alex@example.test');
    assert.equal(row.phone_e164, '+27821234567');
    const snapshot = JSON.stringify(f.db.prepare('SELECT * FROM audit_log').all());
    assert.equal(snapshot.includes(requests[0].status_secret), false);
  } finally { f.close(); }
});

test('persistent throttles cap unique visitor requests and survive creating a new service', async () => {
  const f = fixture();
  try {
    for (let i = 0; i < 5; i++) {
      const result = await f.service().requestAccess({ ...f.applicant, email: `visitor${i}@example.test`, phone: `+2782123400${i}` });
      assert.equal(result.ok, true);
    }
    const stopped = await f.service().requestAccess({ ...f.applicant, email: 'sixth@example.test' });
    assert.equal(stopped.reason, 'rate_limited');
    assert.equal(f.sent.length, 5);
  } finally { f.close(); }
});

test('configured owner must be existing, active, SMS enrolled and bound to the private phone; transport fails closed', async () => {
  for (const overrides of [{ ACCOUNT_APPROVAL_OWNER_USER_ID: '999' }, { ACCOUNT_APPROVAL_OWNER_SMS_E164: '+27821239999' }, { APP_BASE_URL: 'http://attacker.example' }, { OTP_HASH_KEY: 'auto' }]) {
    const f = fixture({ env: overrides });
    try {
      assert.equal((await f.service().requestAccess(f.applicant)).reason, 'approval_unavailable');
      assert.equal(f.db.prepare('SELECT COUNT(*) n FROM registration_requests').get().n, 0);
      assert.equal(f.sent.length, 0);
    } finally { f.close(); }
  }
  const f = fixture({ sender: { configured: false } });
  try { assert.equal((await f.service().requestAccess(f.applicant)).reason, 'approval_unavailable'); }
  finally { f.close(); }
});

test('owner SMS delivery failure preserves pending state with bounded owner-only retry and no visitor retry', async () => {
  const f = fixture({ failSms: true });
  try {
    const request = await f.service().requestAccess(f.applicant);
    assert.equal(request.ok, true);
    let stored = f.db.prepare('SELECT * FROM registration_requests').get();
    assert.equal(stored.status, 'pending');
    assert.equal(stored.notification_status, 'failed');
    await f.service().requestAccess({ ...f.applicant, ipAddress: '192.0.2.2' });
    assert.equal(f.sent.length, 1);
    assert.equal((await f.service().notifyOwner(request.request_id, { retry: true })).reason, 'notification_limited');
    for (let i = 0; i < 2; i++) {
      f.advance(5 * 60 * 1000);
      assert.equal((await f.service().notifyOwner(request.request_id, { retry: true })).reason, 'notification_failed');
    }
    f.advance(5 * 60 * 1000);
    assert.equal((await f.service().notifyOwner(request.request_id, { retry: true })).reason, 'notification_limited');
    stored = f.db.prepare('SELECT * FROM registration_requests').get();
    assert.equal(stored.notification_attempts, 3);
    assert.equal(f.sent.length, 3);
  } finally { f.close(); }
});

test('decisions require current SMS owner and explicit confirmation; duplicate approval issues no second invitation', async () => {
  const f = fixture();
  try {
    const request = await f.service().requestAccess(f.applicant);
    for (const actor of [null, { id: 1 }, { id: 1, mfa: 'sms_otp', auth_version: 99 }, { id: 2, mfa: 'sms_otp' }]) {
      assert.equal(f.service().decide({ requestId: request.request_id, actor, decision: 'approve', confirmed: true }).reason, 'owner_required');
    }
    assert.equal(f.service().decide({ requestId: request.request_id, actor: f.actor, decision: 'approve' }).reason, 'confirmation_required');
    const accepted = f.service().decide({ requestId: request.request_id, actor: f.actor, decision: 'approve', confirmed: true });
    assert.equal(accepted.ok, true);
    assert.equal(Date.parse(accepted.expires_at) - Date.parse('2026-11-03T10:00:00.000Z'), INVITATION_TTL_MS);
    assert.equal(f.service().decide({ requestId: request.request_id, actor: f.actor, decision: 'approve', confirmed: true }).reason, 'not_pending');
    assert.equal(f.service().requestStatus({ requestId: request.request_id, statusSecret: request.status_secret }).invitation_token, accepted.invitation_token);
    assert.equal(f.service().requestStatus({ requestId: request.request_id, statusSecret: 'f'.repeat(64) }).status, 'pending');
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM users').get().n, 1);
    assert.equal(f.sent.length, 1);
  } finally { f.close(); }
});

test('invitation is exact-contact bound, hash stored, 48-hour limited and consumed with one registered user', async () => {
  const f = fixture();
  try {
    const { approved } = await approve(f), invitationToken = approved.invitation_token;
    assert.equal(f.service().validateInvitation({ invitationToken, email: 'different@example.test' }).reason, 'invitation_identity_mismatch');
    assert.equal(f.service().validateInvitation({ invitationToken, phone: '+27821239999' }).reason, 'invitation_identity_mismatch');
    assert.equal(f.service().validateInvitation({ invitationToken: `${invitationToken.slice(0, -1)}x` }).reason, 'invitation_invalid');
    assert.equal(JSON.stringify(f.db.prepare('SELECT * FROM registration_requests').get()).includes(invitationToken), false);
    f.db.transaction(() => {
      const inserted = f.db.prepare("INSERT INTO users(email,name,password_hash,sms_2fa_phone_e164,account_status) VALUES(?,?,?,?,'registered_unverified')")
        .run(approved.email, approved.name, 'new-hash', approved.phone);
      const consumed = f.service().consumeInvitation({ invitationToken, userId: Number(inserted.lastInsertRowid) });
      assert.equal(consumed.ok, true);
    }).immediate();
    assert.equal(f.service().validateInvitation({ invitationToken }).reason, 'invitation_used');
    const user = f.db.prepare('SELECT * FROM users WHERE id=2').get();
    assert.equal(f.service().accountAccess(user).ok, true);
    assert.equal(f.service().accountAccess(user, { phone: '+27821239999' }).reason, 'phone_changed');
    assert.equal(f.db.prepare('SELECT registered_user_id FROM registration_requests').get().registered_user_id, 2);
  } finally { f.close(); }
  const expired = fixture();
  try {
    const { approved } = await approve(expired);
    expired.advance(INVITATION_TTL_MS);
    assert.equal(expired.service().validateInvitation({ invitationToken: approved.invitation_token }).reason, 'invitation_expired');
  } finally { expired.close(); }
});

test('rejection denies either canonical contact without new messages, and only an audited owner lift permits a new request', async () => {
  const f = fixture();
  try {
    const request = await f.service().requestAccess(f.applicant);
    const denied = f.service().decide({ requestId: request.request_id, actor: f.actor, decision: 'reject', confirmed: true, reason: 'Private reason' });
    assert.equal(denied.status, 'rejected');
    const state = f.service().requestStatus({ requestId: request.request_id, statusSecret: request.status_secret });
    assert.equal(state.status, 'rejected');
    assert.equal(JSON.stringify(state).includes('Private reason'), false);
    for (const applicant of [{ ...f.applicant, email: 'other@example.test', phone: '+27 82 123 4567' }, { ...f.applicant, phone: '+27821239998' }]) {
      assert.equal((await f.service().requestAccess(applicant)).ok, true);
    }
    assert.equal(f.sent.length, 1);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM registration_requests').get().n, 1);
    const denialId = f.db.prepare('SELECT id FROM registration_denials').get().id;
    assert.equal(f.service().liftDenial({ denialId, actor: f.actor }).reason, 'confirmation_required');
    assert.equal(f.service().liftDenial({ denialId, actor: f.actor, confirmed: true }).ok, true);
    f.advance(60 * 60 * 1000);
    assert.equal((await f.service().requestAccess(f.applicant)).ok, true);
    assert.equal(f.sent.length, 2);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='denial_lifted'").get().n, 1);
  } finally { f.close(); }
});

test('saved-profile and account contact collisions suppress fraudulent requests; forged denial cannot block an existing legitimate user', async () => {
  const f = fixture();
  try {
    f.db.prepare('INSERT INTO users(id,email,name,password_hash) VALUES(2,?,?,?)').run('legacy@example.test', 'Legacy', 'old');
    f.db.prepare('INSERT INTO vault_entries VALUES(?,?,?)').run(2, 'personal', JSON.stringify({ mobile_phone: '0821234999' }));
    for (const phone of ['+27821230001', '+27821234999']) {
      assert.equal((await f.service().requestAccess({ ...f.applicant, phone })).ok, true);
    }
    assert.equal(f.sent.length, 0);
    const request = await f.service().requestAccess(f.applicant);
    f.db.prepare('UPDATE registration_requests SET phone_e164=? WHERE id=?').run('+27821230001', request.request_id);
    assert.equal(f.service().decide({ requestId: request.request_id, actor: f.actor, decision: 'reject', confirmed: true }).ok, true);
    const owner = f.db.prepare('SELECT * FROM users WHERE id=1').get();
    assert.equal(f.service().hasDenial(owner.email, owner.sms_2fa_phone_e164), true);
    assert.equal(f.service().accountAccess(owner).ok, true);
    assert.equal(owner.account_status, 'active');
    assert.equal(owner.sms_2fa_phone_e164, '+27821230001');
  } finally { f.close(); }
});

test('default profile decryption protects every saved phone when legacy profiles are ambiguous', async () => {
  const f = fixture();
  const previousEncryptionKey = process.env.ENCRYPTION_KEY;
  try {
    process.env.ENCRYPTION_KEY = 'd'.repeat(64);
    const { encrypt } = require('../server/crypto');
    f.db.prepare('UPDATE vault_entries SET fields_encrypted=? WHERE user_id=1')
      .run(encrypt(JSON.stringify({ mobile_phone: '+27821230001' })));
    f.db.prepare('INSERT INTO users(id,email,name,password_hash) VALUES(2,?,?,?)').run('ambiguous@example.test', 'Legacy', 'old');
    for (const phone of ['+27821234999', '+27821234998']) {
      f.db.prepare('INSERT INTO vault_entries VALUES(?,?,?)').run(2, 'personal', encrypt(JSON.stringify({ mobile_phone: phone })));
    }
    const service = createRegistrationApprovalService({ db: f.db, env: f.env, smsSender: f.sender });
    for (const phone of ['+27821234999', '+27821234998']) {
      assert.equal((await service.requestAccess({ ...f.applicant, phone })).ok, true);
    }
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM registration_requests').get().n, 0);
    assert.equal(f.sent.length, 0);
    assert.equal(f.db.prepare('SELECT account_status FROM users WHERE id=2').get().account_status, 'active');
  } finally {
    if (previousEncryptionKey === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = previousEncryptionKey;
    f.close();
  }
});

test('separate confirmed account block revokes OTPs/recovery and auth version while protecting owner', async () => {
  const f = fixture();
  try {
    f.db.prepare('INSERT INTO users(id,email,name,password_hash,sms_2fa_enabled) VALUES(2,?,?,?,1)').run('member@example.test', 'Member', 'old');
    f.db.prepare("INSERT INTO sms_otp_challenges(id,user_id,purpose,phone_e164,otp_hash,challenge_token_hash,expires_at,resend_available_at,created_at,last_sent_at) VALUES('challenge',2,'login','+27821234999','hash','token','later','later','now','now')").run();
    f.db.prepare("INSERT INTO sms_otp_recovery_codes(user_id,batch_id,code_hash,created_at) VALUES(2,'batch','hash','now')").run();
    assert.equal(f.service().blockUser({ userId: 1, actor: f.actor, confirmed: true }).reason, 'owner_protected');
    assert.equal(f.service().blockUser({ userId: 2, actor: f.actor, confirmed: true }).ok, true);
    const user = f.db.prepare('SELECT * FROM users WHERE id=2').get();
    assert.equal(user.account_status, 'blocked');
    assert.equal(user.auth_version, 1);
    assert.equal(f.service().accountAccess(user).reason, 'account_blocked');
    assert.ok(f.db.prepare('SELECT used_at FROM sms_otp_challenges').get().used_at);
    assert.ok(f.db.prepare('SELECT revoked_at FROM sms_otp_recovery_codes').get().revoked_at);
    assert.equal(f.db.prepare('SELECT account_status FROM users WHERE id=1').get().account_status, 'active');
  } finally { f.close(); }
});
