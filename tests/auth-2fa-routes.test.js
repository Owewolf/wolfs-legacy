'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// Install the guard before importing application code. Even an accidentally
// uninjected database/audit dependency must never open the checkout's vault.
let persistentDatabaseAttempts = 0;
require.cache[require.resolve('better-sqlite3')].exports = function FixtureDatabase(filename, ...options) {
  if (filename !== ':memory:') {
    persistentDatabaseAttempts++;
    throw new Error('Persistent databases are forbidden in authentication route tests');
  }
  return new Database(filename, ...options);
};
test.after(() => assert.equal(persistentDatabaseAttempts, 0, 'all route database dependencies remain synthetic'));

const { initSmsOtpSchema } = require('../server/sms-otp');
const { initRegistrationApprovalSchema, createRegistrationApprovalService } = require('../server/registration-approval');
const { createAuthRouter } = require('../server/routes/auth');

function createDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      totp_secret TEXT,
      totp_enabled INTEGER DEFAULT 0,
      sms_2fa_phone_e164 TEXT,
      sms_2fa_enabled INTEGER DEFAULT 0,
      sms_2fa_enrolled_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_check_in DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE beneficiaries(id INTEGER PRIMARY KEY,user_id INTEGER NOT NULL,name TEXT,email TEXT,phone TEXT);
    CREATE TABLE dead_switch_config (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL UNIQUE,
      check_in_interval_days INTEGER DEFAULT 30,
      grace_period_days INTEGER DEFAULT 7,
      is_active INTEGER DEFAULT 0,
      switch_triggered INTEGER DEFAULT 0,
      switch_triggered_at DATETIME
    );
    CREATE TABLE audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      action TEXT NOT NULL,
      target_type TEXT,
      target_id INTEGER,
      detail TEXT,
      ip_address TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  initSmsOtpSchema(db);
  initRegistrationApprovalSchema(db);
  return db;
}

async function createServer(db, smsProvider, env = {}, dependencies = {}) {
  const app = express();
  app.use(express.json());
  app.locals.getDb = () => db;
  const mergedEnv = {
    JWT_SECRET: 'test-secret',
    OTP_HASH_KEY: 'z'.repeat(32),
    ENCRYPTION_KEY: 'a'.repeat(64),
    ...env
  };
  process.env.JWT_SECRET = mergedEnv.JWT_SECRET;
  app.locals.authEnv = mergedEnv;
  app.use('/api/auth', createAuthRouter({
    dbGetter: () => db,
    auditWriter(userId, action, targetType, targetId, detail, ip) {
      db.prepare('INSERT INTO audit_log(user_id,action,target_type,target_id,detail,ip_address) VALUES(?,?,?,?,?,?)')
        .run(userId, action, targetType || null, targetId || null, detail || null, ip || null);
    },
    env: mergedEnv,
    smsProvider,
    ...dependencies
  }));
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  return server;
}

async function requestJson(server, method, path, body, token) {
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json();
  return { status: res.status, data };
}

test('public registration cannot create an account or issue a JWT before approval', async () => {
  const db = createDb();
  const smsProvider = { configured: true, sendOtp: async () => ({}) };
  const server = await createServer(db, smsProvider);

  try {
    const res = await requestJson(server, 'POST', '/api/auth/register', {
      email: 'owner@example.test',
      name: 'Owner',
      password: 'StrongPass123!'
    });
    assert.equal(res.status, 403);
    assert.equal(Boolean(res.data.token), false);
    assert.equal(res.data.code, 'APPROVAL_REQUIRED');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 0);
  } finally {
    server.close();
    db.close();
  }
});

function seedUser(db, { email = 'required@example.test', phone = null, enabled = 0 } = {}) {
  return Number(db.prepare('INSERT INTO users(email,password_hash,name,sms_2fa_phone_e164,sms_2fa_enabled) VALUES(?,?,?,?,?)')
    .run(email, bcrypt.hashSync('StrongPass123!', 4), 'Synthetic owner', phone, enabled).lastInsertRowid);
}

function capturingProvider() {
  const sent = [];
  return { configured: true, sent, async sendOtp(payload) { sent.push(payload); } };
}

function lastOtp(provider) { return provider.sent.at(-1).message.match(/\b(\d{6})\b/)[1]; }

function approvalFixture(db, provider) {
  const ownerId = seedUser(db, { email: 'approving-owner@example.test', phone: '+27820000001', enabled: 1 });
  db.prepare('INSERT INTO beneficiaries(user_id,name,email,phone) VALUES(?,?,?,?)').run(ownerId, 'Synthetic applicant', 'required@example.test', '+27821234567');
  const env = { AUTH_SMS_REQUIRED: 'true', ACCOUNT_FAMILY_ROOT_USER_ID: String(ownerId), ACCOUNT_APPROVAL_OWNER_USER_ID: String(ownerId), ACCOUNT_APPROVAL_OWNER_SMS_E164: '+27820000001',
    APP_BASE_URL: 'https://example.test', OTP_HASH_KEY: 'z'.repeat(32) };
  const approvals = createRegistrationApprovalService({ db, env, smsSender: provider, auditWriter() {} });
  return { env, approvals, actor: { id: ownerId, mfa: 'sms_otp', auth_version: 0 } };
}

async function loginRequired(server, email = 'required@example.test') {
  return requestJson(server, 'POST', '/api/auth/login', { email, password: 'StrongPass123!' });
}

async function verifyChallenge(server, challenge, otp) {
  return requestJson(server, 'POST', '/api/auth/login/challenge/verify', {
    challenge_id: challenge.challenge_id, challenge_token: challenge.challenge_token, otp
  });
}

test('approved registration validates mobile and issues no session before SMS verification', async () => {
  const db = createDb(), provider = capturingProvider();
  const approval = approvalFixture(db, provider);
  const server = await createServer(db, provider, approval.env);
  const registration = { email: 'required@example.test', password: 'StrongPass123!', name: 'Synthetic owner' };
  try {
    for (const phone of [undefined, 'not a mobile', '+123']) {
      const invalid = await requestJson(server, 'POST', '/api/auth/registration-requests', { ...registration, phone });
      assert.equal(invalid.status, 400);
      assert.equal(db.prepare('SELECT COUNT(*) n FROM users').get().n, 1);
    }
    const requested = await requestJson(server, 'POST', '/api/auth/registration-requests', { ...registration, phone: '082 123 4567' });
    const invite = approval.approvals.decide({ requestId: requested.data.request_id, actor: approval.actor, decision: 'approve', confirmed: true });
    assert.equal(invite.ok, true);
    const started = await requestJson(server, 'POST', '/api/auth/register', { ...registration, phone: '082 123 4567', invitation_token: invite.invitation_token });
    assert.equal(started.status, 201);
    assert.equal(started.data.account_created, true);
    assert.equal(started.data.requires_second_factor, true);
    assert.equal(started.data.recovery_code_allowed, false);
    assert.equal(started.data.token, undefined);
    assert.equal(provider.sent.at(-1).to, '+27821234567');
    assert.equal(db.prepare('SELECT sms_2fa_enabled FROM users WHERE email=?').get(registration.email).sms_2fa_enabled, 0);
    const verified = await verifyChallenge(server, started.data, lastOtp(provider));
    assert.equal(verified.status, 200);
    assert.equal(jwt.verify(verified.data.token, 'test-secret').mfa, 'sms_otp');
    assert.equal(verified.data.recovery_codes.length, 10);
    assert.equal(db.prepare('SELECT sms_2fa_enabled FROM users WHERE email=?').get(registration.email).sms_2fa_enabled, 1);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='sms_2fa_enabled'").get().n, 1);
    assert.equal((await requestJson(server, 'GET', '/api/auth/me', null, verified.data.token)).status, 200);
    const replay = await verifyChallenge(server, started.data, lastOtp(provider));
    assert.equal(replay.data.reason, 'already_used');
    assert.equal(replay.data.token, undefined);
    const next = await loginRequired(server);
    assert.equal(next.data.requires_second_factor, true);
    const signedIn = await verifyChallenge(server, next.data, lastOtp(provider));
    assert.equal(signedIn.status, 200);
    assert.equal(signedIn.data.recovery_codes, undefined);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM sms_otp_recovery_codes').get().n, 10);
  } finally { server.close(); db.close(); }
});

test('registration SMS delivery failure leaves an unverified account recoverable through sign-in', async () => {
  const db = createDb();
  let unavailable = true;
  const provider = capturingProvider();
  const send = provider.sendOtp;
  provider.sendOtp = async payload => { if (unavailable) throw new Error('synthetic unavailable'); return send.call(provider, payload); };
  const approval = approvalFixture(db, provider);
  const server = await createServer(db, provider, approval.env);
  try {
    const requested = await approval.approvals.requestAccess({ name: 'Synthetic owner', email: 'required@example.test', phone: '+27821234567' });
    const invite = approval.approvals.decide({ requestId: requested.request_id, actor: approval.actor, decision: 'approve', confirmed: true });
    assert.equal(invite.ok, true);
    const failed = await requestJson(server, 'POST', '/api/auth/register', {
      email: 'required@example.test', password: 'StrongPass123!', name: 'Synthetic owner', phone: '+27821234567', invitation_token: invite.invitation_token
    });
    assert.equal(failed.status, 503);
    assert.equal(failed.data.account_created, true);
    assert.match(failed.data.error, /Sign in/);
    assert.equal(failed.data.token, undefined);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM users').get().n, 2);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM sms_otp_challenges').get().n, 0);
    unavailable = false;
    const retry = await loginRequired(server);
    assert.equal(retry.data.requires_second_factor, true);
    assert.equal((await verifyChallenge(server, retry.data, lastOtp(provider))).status, 200);
  } finally { server.close(); db.close(); }
});

test('required authentication never falls back to passwords when the SMS provider is unavailable', async () => {
  const db = createDb();
  seedUser(db, { phone: '+27821234567' });
  const server = await createServer(db, { configured: false, sendOtp: async () => { throw new Error('must not send'); } }, { AUTH_SMS_REQUIRED: 'true' });
  try {
    const login = await loginRequired(server);
    assert.equal(login.status, 503);
    assert.equal(login.data.token, undefined);
    const register = await requestJson(server, 'POST', '/api/auth/register', {
      email: 'other@example.test', password: 'StrongPass123!', name: 'Other', phone: '+27821230001'
    });
    assert.equal(register.status, 403);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM users').get().n, 1);
  } finally { server.close(); db.close(); }
});

test('required login uses the sole saved owner mobile, then retains its verified account phone', async () => {
  const db = createDb(), provider = capturingProvider();
  const owner = seedUser(db);
  const other = seedUser(db, { email: 'other@example.test' });
  db.exec('CREATE TABLE vault_entries(user_id INTEGER, section TEXT, fields_encrypted TEXT)');
  const insert = db.prepare('INSERT INTO vault_entries VALUES(?,?,?)');
  insert.run(owner, 'personal', JSON.stringify({ mobile_phone: '0821234567' }));
  insert.run(other, 'personal', JSON.stringify({ mobile_phone: '+27821230002' }));
  insert.run(owner, 'contacts', JSON.stringify({ mobile_phone: '+27821230003' }));
  const server = await createServer(db, provider, { AUTH_SMS_REQUIRED: 'true' }, { decryptFields: value => value });
  try {
    const login = await loginRequired(server);
    assert.equal(login.data.requires_second_factor, true);
    assert.equal(login.data.token, undefined);
    assert.equal(provider.sent[0].to, '+27821234567');
    assert.equal(db.prepare('SELECT sms_2fa_phone_e164 FROM users WHERE id=?').get(owner).sms_2fa_phone_e164, null);
    const verified = await verifyChallenge(server, login.data, lastOtp(provider));
    assert.equal(verified.status, 200);
    assert.equal(verified.data.recovery_codes.length, 10);
    assert.equal(db.prepare('SELECT sms_2fa_phone_e164 FROM users WHERE id=?').get(owner).sms_2fa_phone_e164, '+27821234567');
    db.prepare("UPDATE vault_entries SET fields_encrypted=? WHERE user_id=? AND section='personal'").run(JSON.stringify({ mobile_phone: '+27821230004' }), owner);
    assert.equal((await loginRequired(server)).data.requires_second_factor, true);
    assert.equal(provider.sent.at(-1).to, '+27821234567');
  } finally { server.close(); db.close(); }
});

test('missing owner phone requires password-bound phone setup and its token cannot access the vault', async () => {
  const db = createDb(), provider = capturingProvider();
  const owner = seedUser(db);
  const server = await createServer(db, provider, { AUTH_SMS_REQUIRED: 'true' });
  try {
    const login = await loginRequired(server);
    assert.equal(login.data.requires_phone_setup, true);
    assert.equal(login.data.token, undefined);
    assert.equal(provider.sent.length, 0);
    const forbidden = await requestJson(server, 'GET', '/api/auth/me', null, login.data.setup_token);
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.data.code, 'PHONE_SETUP_TOKEN_FORBIDDEN');
    const started = await requestJson(server, 'POST', '/api/auth/login/phone', { setup_token: login.data.setup_token, phone: '0821234567' });
    assert.equal(started.status, 200);
    assert.equal(started.data.requires_second_factor, true);
    assert.equal(started.data.token, undefined);
    assert.equal(db.prepare('SELECT sms_2fa_enabled FROM users WHERE id=?').get(owner).sms_2fa_enabled, 0);
    const completed = await verifyChallenge(server, started.data, lastOtp(provider));
    assert.equal(completed.status, 200);
    assert.equal(completed.data.recovery_codes.length, 10);
    const replace = await requestJson(server, 'POST', '/api/auth/login/phone', { setup_token: login.data.setup_token, phone: '+27821230099' });
    assert.equal(replace.status, 403);
    assert.equal(db.prepare('SELECT sms_2fa_phone_e164 FROM users WHERE id=?').get(owner).sms_2fa_phone_e164, '+27821234567');
  } finally { server.close(); db.close(); }
});

test('ambiguous profile mobiles require explicit setup and do not send to an arbitrary profile', async () => {
  const db = createDb(), provider = capturingProvider();
  const owner = seedUser(db);
  db.exec('CREATE TABLE vault_entries(user_id INTEGER, section TEXT, fields_encrypted TEXT)');
  const insert = db.prepare('INSERT INTO vault_entries VALUES(?,?,?)');
  insert.run(owner, 'personal', JSON.stringify({ mobile_phone: '+27821230001' }));
  insert.run(owner, 'personal', JSON.stringify({ mobile_phone: '+27821230002' }));
  const server = await createServer(db, provider, { AUTH_SMS_REQUIRED: 'true' }, { decryptFields: value => value });
  try {
    const login = await loginRequired(server);
    assert.equal(login.data.requires_phone_setup, true);
    assert.equal(login.data.token, undefined);
    assert.equal(provider.sent.length, 0);
  } finally { server.close(); db.close(); }
});

test('phone setup tokens expire, bind to the password, and cannot be replaced by a session token', async () => {
  const db = createDb(), provider = capturingProvider();
  const owner = seedUser(db);
  const server = await createServer(db, provider, { AUTH_SMS_REQUIRED: 'true' });
  try {
    const setup = (await loginRequired(server)).data;
    const payload = jwt.verify(setup.setup_token, 'test-secret');
    const expired = jwt.sign({ ...payload, exp: Math.floor(Date.now() / 1000) - 1 }, 'test-secret');
    const call = setupToken => requestJson(server, 'POST', '/api/auth/login/phone', { setup_token: setupToken, phone: '+27821234567' });
    assert.equal((await call(expired)).status, 403);
    assert.equal((await call(jwt.sign({ id: owner, mfa: 'sms_otp' }, 'test-secret'))).status, 403);
    db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(bcrypt.hashSync('ChangedPass123!', 4), owner);
    assert.equal((await call(setup.setup_token)).status, 403);
    assert.equal(provider.sent.length, 0);
  } finally { server.close(); db.close(); }
});

test('required login invalidates a challenge if its saved phone changes before verification', async () => {
  const db = createDb(), provider = capturingProvider();
  const owner = seedUser(db, { phone: '+27821234567' });
  const server = await createServer(db, provider, { AUTH_SMS_REQUIRED: 'true' });
  try {
    const challenge = (await loginRequired(server)).data;
    db.prepare('UPDATE users SET sms_2fa_phone_e164=? WHERE id=?').run('+27821230099', owner);
    const rejected = await verifyChallenge(server, challenge, lastOtp(provider));
    assert.equal(rejected.status, 400);
    assert.equal(rejected.data.reason, 'phone_changed');
    assert.equal(rejected.data.token, undefined);
    assert.equal(db.prepare('SELECT sms_2fa_enabled FROM users WHERE id=?').get(owner).sms_2fa_enabled, 0);
  } finally { server.close(); db.close(); }
});

test('required login rejects incorrect and expired codes without enabling access', async () => {
  const db = createDb(), provider = capturingProvider();
  const owner = seedUser(db, { phone: '+27821234567' });
  const server = await createServer(db, provider, { AUTH_SMS_REQUIRED: 'true' });
  try {
    const challenge = (await loginRequired(server)).data;
    const wrong = lastOtp(provider) === '000000' ? '000001' : '000000';
    assert.equal((await verifyChallenge(server, challenge, wrong)).data.reason, 'invalid_otp');
    db.prepare('UPDATE sms_otp_challenges SET expires_at=? WHERE id=?').run('2000-01-01T00:00:00.000Z', challenge.challenge_id);
    const expired = await verifyChallenge(server, challenge, lastOtp(provider));
    assert.equal(expired.data.reason, 'expired');
    assert.equal(expired.data.token, undefined);
    assert.equal(db.prepare('SELECT sms_2fa_enabled FROM users WHERE id=?').get(owner).sms_2fa_enabled, 0);
  } finally { server.close(); db.close(); }
});

test('required policy rejects pre-MFA sessions and forbids disabling SMS authentication', async () => {
  const db = createDb(), provider = capturingProvider();
  const owner = seedUser(db, { phone: '+27821234567', enabled: 1 });
  const server = await createServer(db, provider, { AUTH_SMS_REQUIRED: 'true' });
  try {
    const oldToken = jwt.sign({ id: owner }, 'test-secret');
    const oldSession = await requestJson(server, 'GET', '/api/auth/me', null, oldToken);
    assert.equal(oldSession.status, 403);
    assert.equal(oldSession.data.code, 'SMS_VERIFICATION_REQUIRED');
    const session = jwt.sign({ id: owner, mfa: 'sms_otp' }, 'test-secret');
    const status = await requestJson(server, 'GET', '/api/auth/2fa/status', null, session);
    assert.equal(status.data.required, true);
    assert.equal(status.data.transport_configured, true);
    assert.equal(status.data.simulated, false);
    const disable = await requestJson(server, 'POST', '/api/auth/2fa/disable', { current_password: 'StrongPass123!', recovery_code: 'arbitrary' }, session);
    assert.equal(disable.status, 403);
    assert.equal(db.prepare('SELECT sms_2fa_enabled FROM users WHERE id=?').get(owner).sms_2fa_enabled, 1);
  } finally { server.close(); db.close(); }
});

test('2fa-enabled login requires challenge and delays jwt', async () => {
  const db = createDb();
  const passwordHash = await bcrypt.hash('StrongPass123!', 12);
  db.prepare('INSERT INTO users(email,password_hash,name,sms_2fa_enabled,sms_2fa_phone_e164) VALUES(?,?,?,?,?)')
    .run('owner@example.test', passwordHash, 'Owner', 1, '+27821239999');

  const sent = [];
  const smsProvider = {
    configured: true,
    async sendOtp(payload) {
      sent.push(payload);
      return {};
    }
  };

  const server = await createServer(db, smsProvider);
  try {
    const step1 = await requestJson(server, 'POST', '/api/auth/login', {
      email: 'owner@example.test',
      password: 'StrongPass123!'
    });
    assert.equal(step1.status, 200);
    assert.equal(step1.data.requires_second_factor, true);
    assert.equal(Boolean(step1.data.token), false);
    assert.equal(sent.length, 1);

    const otp = sent[0].message.match(/(\d{6})/)[1];
    const step2 = await requestJson(server, 'POST', '/api/auth/login/challenge/verify', {
      challenge_id: step1.data.challenge_id,
      challenge_token: step1.data.challenge_token,
      otp
    });
    assert.equal(step2.status, 200);
    assert.equal(typeof step2.data.token, 'string');
  } finally {
    server.close();
    db.close();
  }
});

test('2fa enrollment endpoints work with authenticated user', async () => {
  const db = createDb();
  const passwordHash = await bcrypt.hash('StrongPass123!', 12);
  const r = db.prepare('INSERT INTO users(email,password_hash,name) VALUES(?,?,?)').run('owner@example.test', passwordHash, 'Owner');
  db.prepare('INSERT INTO dead_switch_config(user_id) VALUES(?)').run(r.lastInsertRowid);

  const sent = [];
  const smsProvider = {
    configured: true,
    async sendOtp(payload) {
      sent.push(payload);
      return {};
    }
  };

  const server = await createServer(db, smsProvider);
  try {
    const login = await requestJson(server, 'POST', '/api/auth/login', {
      email: 'owner@example.test',
      password: 'StrongPass123!'
    });
    assert.equal(login.status, 200);
    const token = login.data.token;

    const start = await requestJson(server, 'POST', '/api/auth/2fa/enroll/start', {
      phone: '+27821230088',
      current_password: 'StrongPass123!'
    }, token);
    assert.equal(start.status, 200);
    assert.equal(sent.length, 1);

    const otp = sent[0].message.match(/(\d{6})/)[1];
    const verify = await requestJson(server, 'POST', '/api/auth/2fa/enroll/verify', {
      challenge_id: start.data.challenge_id,
      challenge_token: start.data.challenge_token,
      otp
    }, token);
    assert.equal(verify.status, 200);
    assert.equal(Array.isArray(verify.data.recovery_codes), true);
    assert.equal(verify.data.recovery_codes.length, 10);
    assert.equal(typeof verify.data.token, 'string');
    assert.equal(jwt.verify(verify.data.token, 'test-secret').mfa, 'sms_otp');
    assert.equal(verify.data.user.email, 'owner@example.test');
    assert.equal((await requestJson(server, 'GET', '/api/auth/me', null, token)).status, 403,
      'enrollment invalidates the password-only session');
    const authorised = await requestJson(server, 'GET', '/api/auth/me', null, verify.data.token);
    assert.equal(authorised.status, 200);
    assert.equal(authorised.data.id, Number(r.lastInsertRowid));
    assert.equal(authorised.data.sms_2fa_enabled, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action='sms_2fa_enabled'").get().n, 1);

    const me = db.prepare('SELECT sms_2fa_enabled FROM users WHERE id=?').get(r.lastInsertRowid);
    assert.equal(me.sms_2fa_enabled, 1);
  } finally {
    server.close();
    db.close();
  }
});
