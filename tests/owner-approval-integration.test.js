'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// A missed injection must never open this checkout's actual vault database.
let persistentDatabaseAttempts = 0;
require.cache[require.resolve('better-sqlite3')].exports = function SyntheticDatabase(filename, ...options) {
  if (filename !== ':memory:' && !Buffer.isBuffer(filename)) {
    persistentDatabaseAttempts++;
    throw new Error('Only disposable databases are permitted in approval integration tests');
  }
  return new Database(filename, ...options);
};
test.after(() => assert.equal(persistentDatabaseAttempts, 0));

const { initSmsOtpSchema } = require('../server/sms-otp');
const { initRegistrationApprovalSchema } = require('../server/registration-approval');
const { createAuthRouter } = require('../server/routes/auth');

const PASSWORD = 'SyntheticPass123!';
const OWNER_PHONE = '+27820000001';
const APPLICANT = { name: 'Synthetic Applicant', email: 'applicant@example.test', phone: '+27821110001' };

function database(snapshot) {
  const db = new Database(snapshot || ':memory:');
  if (!snapshot) {
    db.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, name TEXT NOT NULL,
        totp_secret TEXT, totp_enabled INTEGER DEFAULT 0,
        sms_2fa_phone_e164 TEXT, sms_2fa_enabled INTEGER DEFAULT 0,
        sms_2fa_enrolled_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_check_in DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE dead_switch_config (id INTEGER PRIMARY KEY, user_id INTEGER UNIQUE NOT NULL);
      CREATE TABLE audit_log (
        id INTEGER PRIMARY KEY, user_id INTEGER, action TEXT NOT NULL,
        target_type TEXT, target_id TEXT, detail TEXT, ip_address TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);
  }
  initSmsOtpSchema(db);
  initRegistrationApprovalSchema(db);
  return db;
}

function seed(db, { email = 'owner@example.test', phone = OWNER_PHONE, enabled = 1 } = {}) {
  return Number(db.prepare('INSERT INTO users(email,password_hash,name,sms_2fa_phone_e164,sms_2fa_enabled) VALUES(?,?,?,?,?)')
    .run(email, bcrypt.hashSync(PASSWORD, 4), 'Synthetic Existing User', phone, enabled).lastInsertRowid);
}

function smsProvider() {
  return { configured: true, sent: [], async sendOtp(message) { this.sent.push(message); } };
}

async function fixture({ db = database(), provider = smsProvider(), env = {}, ownerId, clock = { value: Date.now() } } = {}) {
  ownerId ??= seed(db);
  const authEnv = {
    JWT_SECRET: 'synthetic-jwt-secret-at-least-thirty-two-characters',
    OTP_HASH_KEY: 'synthetic-otp-secret-at-least-thirty-two-characters',
    ENCRYPTION_KEY: 'a'.repeat(64),
    AUTH_SMS_REQUIRED: 'true', ACCOUNT_APPROVAL_REQUIRED: 'true',
    ACCOUNT_APPROVAL_OWNER_USER_ID: String(ownerId),
    ACCOUNT_APPROVAL_OWNER_SMS_E164: OWNER_PHONE,
    APP_BASE_URL: 'https://approval.example.test', ...env
  };
  const app = express();
  app.use(express.json());
  app.locals.getDb = () => db;
  app.locals.authEnv = authEnv;
  process.env.JWT_SECRET = authEnv.JWT_SECRET;
  app.use('/api/auth', createAuthRouter({
    dbGetter: () => db, env: authEnv, smsProvider: provider, now: () => clock.value,
    auditWriter(userId, action, targetType, targetId, detail, ip) {
      db.prepare('INSERT INTO audit_log(user_id,action,target_type,target_id,detail,ip_address) VALUES(?,?,?,?,?,?)')
        .run(userId ?? null, action, targetType ?? null, targetId ?? null, detail ?? null, ip ?? null);
    }
  }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const token = (id = ownerId, claims = {}) => jwt.sign({ id, mfa: 'sms_otp', auth_version: 0, ...claims }, authEnv.JWT_SECRET, { expiresIn: '1h' });
  return { db, provider, server, env: authEnv, ownerId, clock, token,
    async close() { await new Promise(resolve => server.close(resolve)); db.close(); }
  };
}

async function api(f, method, path, body, token, headers = {}) {
  const response = await fetch(`http://127.0.0.1:${f.server.address().port}/api/auth${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { text }; }
  return { status: response.status, data, headers: response.headers };
}

async function submit(f, applicant = APPLICANT) {
  const result = await api(f, 'POST', '/registration-requests', applicant);
  assert.equal(result.status, 202, JSON.stringify(result.data));
  return result.data;
}

async function approve(f, request) {
  const response = await api(f, 'POST', `/admin/registration-requests/${request.request_id}/approve`, { confirmed: true }, f.token());
  assert.equal(response.status, 200, JSON.stringify(response.data));
  if (response.data.invitation_token) return response.data.invitation_token;
  const status = await api(f, 'GET', `/registration-requests/status?request_id=${request.request_id}`, undefined, undefined,
    { 'X-Registration-Secret': request.status_secret });
  assert.equal(status.status, 200, JSON.stringify(status.data));
  if (status.data.invitation_token) return status.data.invitation_token;
  const invitation = response.data.invitation_url || status.data.invitation_url;
  assert.ok(invitation, 'approval exposes a private invitation');
  return new URLSearchParams(new URL(invitation).hash.split('?')[1] || new URL(invitation).search).get('token');
}

const userCount = f => f.db.prepare('SELECT COUNT(*) n FROM users').get().n;
const code = f => f.provider.sent.at(-1).message.match(/\b(\d{6})\b/)[1];

test('request is pending without a user, session, applicant SMS, or repeat notifications', async () => {
  const f = await fixture();
  try {
    const request = await submit(f);
    assert.equal(userCount(f), 1);
    assert.equal(request.token, undefined);
    assert.equal(f.provider.sent.length, 1);
    assert.equal(f.provider.sent[0].to, OWNER_PHONE);
    assert.match(f.provider.sent[0].message, /Approve|APPROVE/);
    assert.match(f.provider.sent[0].message, /Reject|REJECT/);
    assert.ok(f.provider.sent[0].message.includes(request.request_id));
    const duplicates = await Promise.all(Array.from({ length: 5 }, () => api(f, 'POST', '/registration-requests', APPLICANT)));
    assert.ok(duplicates.every(result => [202, 429].includes(result.status)));
    assert.equal(f.provider.sent.length, 1);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM registration_requests').get().n, 1);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM sms_otp_challenges').get().n, 0);
    const unavailable = await api(f, 'POST', '/register', { ...APPLICANT, password: PASSWORD });
    assert.equal(unavailable.status, 403);
    assert.equal(userCount(f), 1);
  } finally { await f.close(); }
});

test('private status secret cannot be recovered by a duplicate claimant or guessed by request ID', async () => {
  const f = await fixture();
  try {
    const first = await submit(f);
    const duplicate = await submit(f);
    assert.notEqual(duplicate.status_secret, first.status_secret);
    for (const headers of [{}, { 'X-Registration-Secret': duplicate.status_secret }]) {
      const status = await api(f, 'GET', `/registration-requests/status?request_id=${first.request_id}`, undefined, undefined, headers);
      assert.ok([200, 403, 404].includes(status.status));
      if (status.status === 200) assert.equal(status.data.status, 'pending');
      assert.equal(status.data.invitation_token, undefined);
      assert.equal(status.data.email, undefined);
    }
    const status = await api(f, 'GET', `/registration-requests/status?request_id=${first.request_id}`, undefined, undefined,
      { 'X-Registration-Secret': first.status_secret });
    assert.equal(status.status, 200);
    assert.equal(status.data.status, 'pending');
    const record = f.db.prepare('SELECT * FROM registration_requests').get();
    assert.ok(!JSON.stringify(record).includes(first.status_secret), 'database contains only the status-secret hash');
  } finally { await f.close(); }
});

test('decisions require a current SMS-verified owner and POST with explicit confirmation', async () => {
  const f = await fixture();
  try {
    const otherId = seed(f.db, { email: 'existing@example.test', phone: '+27820000002' });
    const request = await submit(f);
    const path = `/admin/registration-requests/${request.request_id}/approve`;
    const forged = jwt.sign({ id: f.ownerId, mfa: 'sms_otp', auth_version: 0 }, 'wrong-signing-key');
    for (const token of [undefined, forged, f.token(otherId, { owner: true, role: 'owner' }), f.token(f.ownerId, { mfa: null })]) {
      const response = await api(f, 'POST', path, { confirmed: true }, token);
      assert.ok([401, 403].includes(response.status), JSON.stringify(response.data));
    }
    assert.notEqual((await api(f, 'GET', path, undefined, f.token())).status, 200);
    assert.equal((await api(f, 'POST', path, {}, f.token())).status, 400);
    assert.equal(f.db.prepare('SELECT status FROM registration_requests WHERE id=?').get(request.request_id).status, 'pending');
    const login = await api(f, 'POST', '/login', { email: 'owner@example.test', password: PASSWORD });
    assert.equal(login.status, 200);
    const verified = await api(f, 'POST', '/login/challenge/verify', {
      challenge_id: login.data.challenge_id, challenge_token: login.data.challenge_token, otp: code(f)
    });
    assert.equal(verified.status, 200);
    const approved = await api(f, 'POST', path, { confirmed: true }, verified.data.token);
    assert.equal(approved.status, 200, JSON.stringify(approved.data));
  } finally { await f.close(); }
});

test('invitation binds the approved email and phone, creates once concurrently, and activates only after OTP', async () => {
  const f = await fixture();
  try {
    const request = await submit(f);
    const invitationToken = await approve(f, request);
    assert.equal(userCount(f), 1);
    assert.equal(f.provider.sent.length, 1);
    for (const altered of [{ email: 'other@example.test' }, { phone: '+27821110002' }]) {
      const invalid = await api(f, 'POST', '/register', { invitation_token: invitationToken, password: PASSWORD, ...altered });
      assert.ok([400, 403, 409].includes(invalid.status), JSON.stringify(invalid.data));
      assert.equal(userCount(f), 1);
    }
    const registrations = await Promise.all(Array.from({ length: 2 }, () => api(f, 'POST', '/register', {
      invitation_token: invitationToken, password: PASSWORD
    })));
    assert.equal(registrations.filter(result => result.status === 201).length, 1, JSON.stringify(registrations));
    assert.equal(userCount(f), 2);
    assert.equal(f.provider.sent.filter(message => message.to === APPLICANT.phone).length, 1);
    const newUser = f.db.prepare('SELECT * FROM users WHERE email=?').get(APPLICANT.email);
    assert.equal(newUser.account_status, 'registered_unverified');
    const started = registrations.find(result => result.status === 201).data;
    assert.equal(started.token, undefined);
    assert.equal((await api(f, 'GET', '/me', undefined, f.token(newUser.id))).status, 403);
    const activated = await api(f, 'POST', '/login/challenge/verify', {
      challenge_id: started.challenge_id, challenge_token: started.challenge_token, otp: code(f)
    });
    assert.equal(activated.status, 200, JSON.stringify(activated.data));
    assert.equal(f.db.prepare('SELECT account_status,sms_2fa_enabled FROM users WHERE id=?').get(newUser.id).account_status, 'active');
    assert.equal((await api(f, 'GET', '/me', undefined, activated.data.token)).status, 200);
    const replay = await api(f, 'POST', '/register', { invitation_token: invitationToken, password: PASSWORD });
    assert.ok([403, 409].includes(replay.status));
    assert.equal(f.provider.sent.filter(message => message.to === APPLICANT.phone).length, 1);
  } finally { await f.close(); }
});

test('invitation metadata uses a private POST body and never accepts a query-string token', async () => {
  const f = await fixture();
  try {
    const invitationToken = await approve(f, await submit(f));
    const legacyLookup = await api(f, 'GET', `/registration-invitation?token=${encodeURIComponent(invitationToken)}`);
    assert.equal(legacyLookup.status, 404);
    assert.equal(legacyLookup.data.email, undefined);
    assert.equal(legacyLookup.data.phone, undefined);
    const queryOnly = await api(f, 'POST', `/registration-invitation?token=${encodeURIComponent(invitationToken)}`, {});
    assert.equal(queryOnly.status, 403);
    assert.equal(queryOnly.data.email, undefined);
    const metadata = await api(f, 'POST', '/registration-invitation', { invitation_token: invitationToken });
    assert.equal(metadata.status, 200, JSON.stringify(metadata.data));
    assert.equal(metadata.headers.get('cache-control'), 'no-store');
    assert.equal(metadata.data.email, APPLICANT.email);
    assert.equal(metadata.data.phone, APPLICANT.phone);
    assert.equal(userCount(f), 1);
    assert.equal(f.provider.sent.length, 1);
  } finally { await f.close(); }
});

test('expired and tampered invitations never provision accounts or send applicant OTP', async () => {
  const f = await fixture();
  try {
    const invitationToken = await approve(f, await submit(f));
    for (const badToken of ['', 'invented', `${invitationToken}x`]) {
      const result = await api(f, 'POST', '/register', { invitation_token: badToken, password: PASSWORD });
      assert.ok([400, 403, 404].includes(result.status), JSON.stringify(result.data));
    }
    f.clock.value += 49 * 60 * 60 * 1000;
    const expired = await api(f, 'POST', '/register', { invitation_token: invitationToken, password: PASSWORD });
    assert.equal(expired.status, 403, JSON.stringify(expired.data));
    assert.equal(userCount(f), 1);
    assert.equal(f.provider.sent.length, 1);
  } finally { await f.close(); }
});

test('rejection persists across reopening and suppresses either denied contact with normalized phones', async () => {
  let f = await fixture();
  try {
    const request = await submit(f);
    assert.equal((await api(f, 'POST', `/admin/registration-requests/${request.request_id}/reject`, {
      confirmed: true, reason: 'Synthetic refusal'
    }, f.token())).status, 200);
    const snapshot = f.db.serialize();
    const ownerId = f.ownerId;
    await f.close();
    f = await fixture({ db: database(snapshot), ownerId });
    for (const applicant of [APPLICANT,
      { ...APPLICANT, email: 'alternate@example.test', phone: '082 111 0001' },
      { ...APPLICANT, email: ' APPLICANT@EXAMPLE.TEST ', phone: '+27821110009' }
    ]) await submit(f, applicant);
    assert.equal(f.provider.sent.length, 0);
    assert.equal(userCount(f), 1);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM registration_requests').get().n, 1);
    const status = await api(f, 'GET', `/registration-requests/status?request_id=${request.request_id}`, undefined, undefined,
      { 'X-Registration-Secret': request.status_secret });
    assert.equal(status.data.status, 'rejected');
    assert.equal(status.data.reason, undefined, 'private rejection reason is not public status data');
  } finally { await f.close(); }
});

test('fraudulent claims of existing contact details cannot create an actionable request or affect legitimate SMS', async () => {
  const f = await fixture();
  try {
    const existingId = seed(f.db, { email: 'existing@example.test', phone: '+27820000002' });
    for (const applicant of [
      { ...APPLICANT, phone: '082 000 0001' },
      { ...APPLICANT, phone: '+27820000002' },
      { ...APPLICANT, email: 'EXISTING@EXAMPLE.TEST' }
    ]) {
      const decoy = await submit(f, applicant);
      const rejected = await api(f, 'POST', `/admin/registration-requests/${decoy.request_id}/reject`, { confirmed: true }, f.token());
      assert.ok([404, 409].includes(rejected.status));
    }
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM registration_requests').get().n, 0);
    assert.equal(f.provider.sent.length, 0);
    for (const [email, phone, id] of [['owner@example.test', OWNER_PHONE, f.ownerId], ['existing@example.test', '+27820000002', existingId]]) {
      const login = await api(f, 'POST', '/login', { email, password: PASSWORD });
      assert.equal(login.status, 200, JSON.stringify(login.data));
      assert.equal(f.provider.sent.at(-1).to, phone);
      assert.equal((await api(f, 'GET', '/me', undefined, f.token(id))).status, 200);
    }
  } finally { await f.close(); }
});

test('rejecting an unverified contact assertion cannot revoke a legitimate account or its outstanding OTP', async () => {
  const f = await fixture();
  try {
    const request = await submit(f);
    // An existing account can acquire its verified phone while an older,
    // unverified application remains in the owner's review queue.
    const id = seed(f.db, { email: APPLICANT.email, phone: APPLICANT.phone });
    const login = await api(f, 'POST', '/login', { email: APPLICANT.email, password: PASSWORD });
    assert.equal(login.status, 200);
    const otp = code(f), beforeRejection = f.provider.sent.length;
    assert.equal((await api(f, 'POST', `/admin/registration-requests/${request.request_id}/reject`, { confirmed: true }, f.token())).status, 200);
    assert.equal(f.provider.sent.length, beforeRejection);
    assert.equal(f.db.prepare('SELECT account_status FROM users WHERE id=?').get(id).account_status, 'active');
    const verified = await api(f, 'POST', '/login/challenge/verify', {
      challenge_id: login.data.challenge_id, challenge_token: login.data.challenge_token, otp
    });
    assert.equal(verified.status, 200, JSON.stringify(verified.data));
    assert.equal((await api(f, 'GET', '/me', undefined, verified.data.token)).status, 200);
    const next = await api(f, 'POST', '/login', { email: APPLICANT.email, password: PASSWORD });
    assert.equal(next.status, 200);
    assert.equal(f.provider.sent.at(-1).to, APPLICANT.phone);
    assert.equal((await api(f, 'GET', '/me', undefined, f.token())).status, 200);
  } finally { await f.close(); }
});

test('explicit account block immediately revokes old JWTs, OTP, recovery, resend, and setup but protects the owner', async () => {
  const f = await fixture();
  try {
    const id = seed(f.db, { email: 'existing@example.test', phone: '+27820000002' });
    const login = await api(f, 'POST', '/login', { email: 'existing@example.test', password: PASSWORD });
    const otp = code(f);
    const oldToken = f.token(id);
    assert.equal((await api(f, 'GET', '/me', undefined, oldToken)).status, 200);
    const blocked = await api(f, 'POST', `/admin/users/${id}/block`, { confirmed: true }, f.token());
    assert.equal(blocked.status, 200, JSON.stringify(blocked.data));
    assert.equal((await api(f, 'GET', '/me', undefined, oldToken)).status, 403);
    const sentAtBlock = f.provider.sent.length;
    for (const endpoint of ['/login/challenge/verify', '/login/challenge/resend']) {
      const result = await api(f, 'POST', endpoint, { challenge_id: login.data.challenge_id, challenge_token: login.data.challenge_token, otp,
        ...(endpoint.endsWith('verify') ? { recovery_code: 'FAKE-CODE' } : {}) });
      assert.ok([400, 403].includes(result.status), JSON.stringify(result.data));
      assert.equal(result.data.token, undefined);
    }
    const passwordLogin = await api(f, 'POST', '/login', { email: 'existing@example.test', password: PASSWORD });
    assert.equal(passwordLogin.status, 403, JSON.stringify(passwordLogin.data));
    assert.equal(f.provider.sent.length, sentAtBlock);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM sms_otp_challenges WHERE user_id=? AND used_at IS NULL').get(id).n, 0);
    const selfBlock = await api(f, 'POST', `/admin/users/${f.ownerId}/block`, { confirmed: true }, f.token());
    assert.ok([400, 403, 409].includes(selfBlock.status));
    assert.equal((await api(f, 'GET', '/me', undefined, f.token())).status, 200);
  } finally { await f.close(); }
});

test('owner notification failure stays pending, while missing or inconsistent owner configuration fails closed', async () => {
  const provider = smsProvider();
  provider.sendOtp = async () => { throw new Error('Synthetic Clickatell unavailable'); };
  const f = await fixture({ provider });
  try {
    const request = await submit(f);
    assert.equal(userCount(f), 1);
    assert.equal(f.db.prepare('SELECT status FROM registration_requests WHERE id=?').get(request.request_id).status, 'pending');
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='approval_sms_failed'").get().n, 1);
    await submit(f);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM registration_requests').get().n, 1);
  } finally { await f.close(); }
  for (const env of [
    { ACCOUNT_APPROVAL_OWNER_USER_ID: '' },
    { ACCOUNT_APPROVAL_OWNER_SMS_E164: '+27829999999' },
    { APP_BASE_URL: '' }
  ]) {
    const unavailable = await fixture({ env });
    try {
      assert.equal((await api(unavailable, 'POST', '/registration-requests', APPLICANT)).status, 503);
      assert.equal(userCount(unavailable), 1);
      assert.equal(unavailable.provider.sent.length, 0);
      assert.equal((await api(unavailable, 'POST', '/register', { ...APPLICANT, password: PASSWORD })).status, 403);
    } finally { await unavailable.close(); }
  }
});

test('new accounts still require SMS activation when legacy password-only sign-in is configured', async () => {
  const f = await fixture({ env: { AUTH_SMS_REQUIRED: 'false', ACCOUNT_APPROVAL_REQUIRED: 'false' } });
  try {
    assert.equal((await api(f, 'POST', '/register', { ...APPLICANT, password: PASSWORD })).status, 403);
    const invitationToken = await approve(f, await submit(f));
    const started = await api(f, 'POST', '/register', { invitation_token: invitationToken, password: PASSWORD });
    assert.equal(started.status, 201);
    const user = f.db.prepare('SELECT * FROM users WHERE email=?').get(APPLICANT.email);
    assert.equal(user.account_status, 'registered_unverified');
    assert.equal(started.data.token, undefined);
    const login = await api(f, 'POST', '/login', { email: APPLICANT.email, password: PASSWORD });
    assert.equal(login.data.token, undefined);
    assert.equal(login.data.requires_second_factor, true);
    const recovery = await api(f, 'POST', '/login/challenge/verify', {
      challenge_id: login.data.challenge_id, challenge_token: login.data.challenge_token, recovery_code: 'FAKE-CODE'
    });
    assert.equal(recovery.status, 400);
    assert.equal(recovery.data.token, undefined);
    const verified = await api(f, 'POST', '/login/challenge/verify', {
      challenge_id: login.data.challenge_id, challenge_token: login.data.challenge_token, otp: code(f)
    });
    assert.equal(verified.status, 200, JSON.stringify(verified.data));
    assert.equal(f.db.prepare('SELECT account_status,sms_2fa_enabled FROM users WHERE id=?').get(user.id).account_status, 'active');
    assert.equal(f.db.prepare('SELECT sms_2fa_enabled FROM users WHERE id=?').get(user.id).sms_2fa_enabled, 1);
    assert.equal((await api(f, 'GET', '/me', undefined, verified.data.token)).status, 200);
    const later = await api(f, 'POST', '/login', { email: APPLICANT.email, password: PASSWORD });
    assert.equal(later.data.requires_second_factor, true);
    assert.equal(later.data.token, undefined);
  } finally { await f.close(); }
});

test('denied and existing phones cannot receive enrollment SMS or replace a legitimate verified phone', async () => {
  const f = await fixture();
  try {
    const id = seed(f.db, { email: 'existing@example.test', phone: '+27820000002' });
    const request = await submit(f);
    assert.equal((await api(f, 'POST', `/admin/registration-requests/${request.request_id}/reject`, { confirmed: true }, f.token())).status, 200);
    const initialCount = f.provider.sent.length;
    for (const phone of [APPLICANT.phone, OWNER_PHONE]) {
      const enrollment = await api(f, 'POST', '/2fa/enroll/start', { phone, current_password: PASSWORD }, f.token(id));
      assert.equal(enrollment.status, 403, JSON.stringify(enrollment.data));
      assert.equal(f.provider.sent.length, initialCount);
      assert.equal(f.db.prepare('SELECT sms_2fa_phone_e164 FROM users WHERE id=?').get(id).sms_2fa_phone_e164, '+27820000002');
    }
    const ownerChange = await api(f, 'POST', '/2fa/enroll/start', { phone: '+27820000009', current_password: PASSWORD }, f.token());
    assert.equal(ownerChange.status, 403);
    assert.equal(f.provider.sent.length, initialCount);
    const stillAllowed = await api(f, 'POST', '/login', { email: 'existing@example.test', password: PASSWORD });
    assert.equal(stillAllowed.status, 200);
    assert.equal(f.provider.sent.at(-1).to, '+27820000002');
  } finally { await f.close(); }
});

test('blocking an existing account invalidates its previously issued phone-setup token', async () => {
  const f = await fixture();
  try {
    const id = seed(f.db, { email: 'unconfigured@example.test', phone: null, enabled: 0 });
    const login = await api(f, 'POST', '/login', { email: 'unconfigured@example.test', password: PASSWORD });
    assert.equal(login.data.requires_phone_setup, true);
    assert.ok(login.data.setup_token);
    assert.equal((await api(f, 'POST', `/admin/users/${id}/block`, { confirmed: true }, f.token())).status, 200);
    const setup = await api(f, 'POST', '/login/phone', { setup_token: login.data.setup_token, phone: '+27820000008' });
    assert.equal(setup.status, 403, JSON.stringify(setup.data));
    assert.equal(f.provider.sent.length, 0);
    assert.equal(f.db.prepare('SELECT sms_2fa_phone_e164 FROM users WHERE id=?').get(id).sms_2fa_phone_e164, null);
  } finally { await f.close(); }
});

test('account creation rolls back invitation consumption when dependent database writes fail', async () => {
  const f = await fixture();
  try {
    const request = await submit(f);
    const invitationToken = await approve(f, request);
    f.db.exec("CREATE TRIGGER synthetic_registration_failure BEFORE INSERT ON dead_switch_config BEGIN SELECT RAISE(ABORT, 'synthetic write failure'); END;");
    const result = await api(f, 'POST', '/register', { invitation_token: invitationToken, password: PASSWORD });
    assert.equal(result.status, 500);
    assert.equal(userCount(f), 1);
    assert.equal(f.provider.sent.length, 1);
    const persisted = f.db.prepare('SELECT status,invitation_used_at,registered_user_id FROM registration_requests WHERE id=?').get(request.request_id);
    assert.deepEqual(persisted, { status: 'approved', invitation_used_at: null, registered_user_id: null });
    f.db.exec('DROP TRIGGER synthetic_registration_failure');
    assert.equal((await api(f, 'POST', '/register', { invitation_token: invitationToken, password: PASSWORD })).status, 201);
    assert.equal(userCount(f), 2);
  } finally { await f.close(); }
});

test('simultaneous opposing decisions produce one permanent outcome and one audit decision', async () => {
  const f = await fixture();
  try {
    const request = await submit(f);
    const decisions = await Promise.all(['approve', 'reject'].map(decision => api(f, 'POST',
      `/admin/registration-requests/${request.request_id}/${decision}`, { confirmed: true }, f.token())));
    assert.equal(decisions.filter(result => result.status === 200).length, 1);
    assert.equal(decisions.filter(result => result.status === 409).length, 1);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action IN ('registration_approved','registration_rejected')").get().n, 1);
    assert.equal(userCount(f), 1);
    assert.equal(f.provider.sent.length, 1);
    const status = f.db.prepare('SELECT status FROM registration_requests WHERE id=?').get(request.request_id).status;
    assert.ok(['approved', 'rejected'].includes(status));
    for (const decision of ['approve', 'reject']) assert.equal((await api(f, 'POST',
      `/admin/registration-requests/${request.request_id}/${decision}`, { confirmed: true }, f.token())).status, 409);
  } finally { await f.close(); }
});
