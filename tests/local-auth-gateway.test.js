'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const gateway = require('../server/local-auth-gateway');
const { initSmsOtpSchema } = require('../server/sms-otp');
const { initRegistrationApprovalSchema, createRegistrationApprovalService } = require('../server/registration-approval');

// Any missed route dependency must fail rather than opening the checkout DB.
require.cache[require.resolve('better-sqlite3')].exports = function SyntheticDatabase(filename, ...args) {
  assert.equal(filename, ':memory:', 'application dependencies may only open synthetic memory databases');
  return new Database(filename, ...args);
};
const { createAuthRouter } = require('../server/routes/auth');
const { authenticateToken } = require('../server/middleware/auth');
const ID = 'synthetic-local-gateway-01', SECRET = 'b9'.repeat(32), PASSWORD = 'SyntheticGatewayPassword123!';
const baseEnv = { AUTH_LOCAL_GATEWAY_ENABLED: 'true', AUTH_LOCAL_GATEWAY_ID: ID, AUTH_LOCAL_GATEWAY_SECRET: SECRET,
  AUTH_SMS_REQUIRED: 'true', JWT_SECRET: 'synthetic-local-gateway-jwt-signing-key', OTP_HASH_KEY: 'synthetic-local-gateway-otp-key-00',
  ACCOUNT_APPROVAL_REQUIRED: 'true', ACCOUNT_APPROVAL_OWNER_USER_ID: '1', ACCOUNT_APPROVAL_OWNER_SMS_E164: '+27820000001',
  APP_BASE_URL: 'https://synthetic.example.test' };

function proof({ method = 'POST', url = '/api/auth/login', authorization = '', timestamp, nonce } = {}) {
  return gateway.signGatewayRequest({ gatewayId: ID, secret: SECRET, method, url, authorization, timestamp, nonce });
}
function rawRequest(headers, { method = 'POST', url = '/api/auth/login' } = {}) {
  return { headers, method, originalUrl: url, rawHeaders: Object.entries(headers).flat() };
}
function nonceDb(filename = ':memory:') {
  const db = new Database(filename); gateway.initLocalAuthGatewaySchema(db); return db;
}
async function fixture(t, { env = {} } = {}) {
  const db = nonceDb();
  db.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY,email TEXT UNIQUE,name TEXT,password_hash TEXT,
    sms_2fa_enabled INTEGER DEFAULT 0,sms_2fa_phone_e164 TEXT,sms_2fa_enrolled_at TEXT,totp_enabled INTEGER DEFAULT 0,
    created_at TEXT,last_check_in TEXT);
    CREATE TABLE dead_switch_config(id INTEGER PRIMARY KEY,user_id INTEGER UNIQUE);
    CREATE TABLE audit_log(id INTEGER PRIMARY KEY,user_id INTEGER,action TEXT,target_type TEXT,target_id INTEGER,detail TEXT,ip_address TEXT,created_at TEXT);`);
  initSmsOtpSchema(db); initRegistrationApprovalSchema(db);
  const insert = db.prepare('INSERT INTO users(id,email,name,password_hash,sms_2fa_enabled,sms_2fa_phone_e164) VALUES(?,?,?,?,?,?)');
  insert.run(1, 'owner@example.test', 'Synthetic Owner', bcrypt.hashSync(PASSWORD, 4), 1, '+27820000001');
  insert.run(2, 'other@example.test', 'Synthetic Other', bcrypt.hashSync(PASSWORD, 4), 1, '+27820000002');
  insert.run(3, 'old@example.test', 'Synthetic old account', bcrypt.hashSync(PASSWORD, 4), 0, null);
  const settings = { ...baseEnv, ...env };
  const sms = [];
  const app = express(); app.use(express.json());
  app.locals.getDb = () => db; app.locals.authEnv = settings;
  app.use('/api/auth', createAuthRouter({ dbGetter: () => db, env: settings, auditWriter: (...args) => {
    db.prepare('INSERT INTO audit_log(user_id,action,target_type,target_id,detail,ip_address) VALUES(?,?,?,?,?,?)')
      .run(...args.map(value => value ?? null));
  }, smsProvider: { configured: true, simulated: false, async sendOtp(message) { sms.push(message); return {}; } } }));
  app.get('/private', authenticateToken, (req, res) => res.json({ ok: true, mfa: req.user.mfa, proof: req.user.local_gateway_verified === true }));
  app.get('/twice', authenticateToken, authenticateToken, (req, res) => res.json({ ok: true, proof: req.user.local_gateway_verified === true }));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); db.close(); });
  async function request(url = '/api/auth/login', { method = url === '/api/auth/login' ? 'POST' : 'GET', token, signed = true, headers = {}, body } = {}) {
    const authorization = token ? 'Bearer ' + token : '';
    const response = await fetch('http://127.0.0.1:' + server.address().port + url, { method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: authorization } : {}),
        ...(signed ? proof({ method, url, authorization }) : {}), ...headers },
      ...(method === 'POST' ? { body: JSON.stringify(body ?? { email: 'owner@example.test', password: PASSWORD }) } : {}) });
    return { status: response.status, data: await response.json(), headers: response.headers };
  }
  return { db, env: settings, sms, request };
}

test('machine proofs bind exact method, raw path/query and authorization and consume one durable nonce', () => {
  const db = nonceDb();
  try {
    const at = Date.now();
    const headers = proof({ url: '/api/private?q=one%20two&x=1', authorization: 'Bearer synthetic', timestamp: String(at) });
    const req = rawRequest({ ...headers, authorization: 'Bearer synthetic' }, { url: '/api/private?q=one%20two&x=1' });
    assert.deepEqual(gateway.verifyGatewayRequest(req, { db, env: baseEnv, now: () => at }), { gatewayId: ID });
    assert.deepEqual(gateway.verifyGatewayRequest(req, { db, env: baseEnv, now: () => at }), { gatewayId: ID }, 'request-scoped duplicate middleware reuses verified proof');
    assert.throws(() => gateway.verifyGatewayRequest(rawRequest(req.headers, { url: req.originalUrl }), { db, env: baseEnv, now: () => at }), { code: 'LOCAL_GATEWAY_INVALID' });
    for (const changed of [{ method: 'GET', url: req.originalUrl }, { url: '/api/private?x=1&q=one%20two' }, { url: '/api/private?q=one+two&x=1' }]) {
      assert.throws(() => gateway.verifyGatewayRequest(rawRequest(req.headers, changed), { db, env: baseEnv, now: () => at }), { code: 'LOCAL_GATEWAY_INVALID' });
    }
    assert.throws(() => gateway.verifyGatewayRequest(rawRequest({ ...req.headers, authorization: 'Bearer different' }, { url: req.originalUrl }), { db, env: baseEnv, now: () => at }), { code: 'LOCAL_GATEWAY_INVALID' });
    assert.equal(db.prepare('SELECT COUNT(*) n FROM local_auth_gateway_nonces').get().n, 1);
  } finally { db.close(); }
});

test('future-dated proof nonces remain consumed for their entire allowed timestamp window', () => {
  const db = nonceDb();
  try {
    const at = 1800000000000, timestamp = String(at + gateway.SKEW_MS);
    const headers = proof({ timestamp });
    gateway.verifyGatewayRequest(rawRequest(headers), { db, env: baseEnv, now: () => at });
    const later = at + gateway.SKEW_MS + 1000;
    gateway.verifyGatewayRequest(rawRequest(proof({ timestamp: String(later) })), { db, env: baseEnv, now: () => later });
    assert.throws(() => gateway.verifyGatewayRequest(rawRequest(headers), { db, env: baseEnv, now: () => later }), { code: 'LOCAL_GATEWAY_INVALID' });
    assert.equal(db.prepare('SELECT expires_at FROM local_auth_gateway_nonces WHERE nonce=?').get(headers['x-wolfs-local-nonce']).expires_at, Number(timestamp) + gateway.SKEW_MS);
  } finally { db.close(); }
});

test('nonce replay is denied across independent SQLite connections and schema reinitialization', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wolfs-local-gateway-nonce-'));
  const db1 = nonceDb(path.join(root, 'nonce.db')), db2 = nonceDb(path.join(root, 'nonce.db'));
  try {
    const headers = proof(); gateway.verifyGatewayRequest(rawRequest(headers), { db: db1, env: baseEnv });
    gateway.initLocalAuthGatewaySchema(db2);
    assert.throws(() => gateway.verifyGatewayRequest(rawRequest(headers), { db: db2, env: baseEnv }), { code: 'LOCAL_GATEWAY_INVALID' });
  } finally { db1.close(); db2.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('proofs reject duplicates, malformed/skewed signatures and broken server configuration without consuming invalid nonces', () => {
  const db = nonceDb();
  try {
    const valid = proof();
    for (const headers of [
      { ...valid, 'x-wolfs-local-signature': '0'.repeat(64) }, { ...valid, 'x-wolfs-local-nonce': 'bad' },
      { ...valid, 'x-wolfs-local-time': String(Date.now() - gateway.SKEW_MS - 1000) },
      { ...valid, 'x-wolfs-local-gateway': 'untrusted-gateway-identifier' }, { 'x-wolfs-local-gateway': ID }
    ]) assert.throws(() => gateway.verifyGatewayRequest(rawRequest(headers), { db, env: baseEnv }), { code: 'LOCAL_GATEWAY_INVALID' });
    for (const duplicate of ['Authorization', 'X-Wolfs-Local-Signature']) {
      const req = rawRequest(valid); req.rawHeaders.push(duplicate, 'first', duplicate, 'second');
      assert.throws(() => gateway.verifyGatewayRequest(req, { db, env: baseEnv }), { code: 'LOCAL_GATEWAY_INVALID' });
    }
    assert.throws(() => gateway.verifyGatewayRequest(rawRequest(valid), { db, env: { ...baseEnv, AUTH_LOCAL_GATEWAY_ENABLED: 'false' } }), { code: 'LOCAL_GATEWAY_INVALID' });
    assert.throws(() => gateway.verifyGatewayRequest(rawRequest(valid), { db, env: { ...baseEnv, AUTH_LOCAL_GATEWAY_SECRET: 'bad' } }), { code: 'LOCAL_GATEWAY_UNAVAILABLE' });
    assert.equal(db.prepare('SELECT COUNT(*) n FROM local_auth_gateway_nonces').get().n, 0);
  } finally { db.close(); }
});

test('valid gateway login checks the password, preserves enrollment, creates a bound local session and sends no SMS', async t => {
  const f = await fixture(t), before = f.db.prepare('SELECT * FROM users ORDER BY id').all();
  assert.equal((await f.request('/api/auth/login', { body: { email: 'owner@example.test', password: 'Wrong password' } })).status, 401);
  const result = await f.request(); assert.equal(result.status, 200); assert.equal(result.data.sms_required, false);
  const claims = jwt.verify(result.data.token, f.env.JWT_SECRET);
  assert.equal(claims.mfa, 'local_gateway'); assert.equal(claims.local_gateway_id, ID); assert.equal(claims.aud, gateway.gatewayAudience(ID));
  assert.equal(claims.local_gateway_verified, undefined); assert.equal(result.data.user.is_registration_owner, true);
  assert.deepEqual(f.db.prepare('SELECT * FROM users ORDER BY id').all(), before);
  assert.equal(f.sms.length, 0); assert.equal(f.db.prepare('SELECT COUNT(*) n FROM sms_otp_challenges').get().n, 0);
  assert.equal((await f.request('/private', { token: result.data.token, signed: false })).status, 403);
  const verified = await f.request('/private', { token: result.data.token });
  assert.equal(verified.status, 200); assert.equal(verified.data.proof, true); assert.equal(verified.data.mfa, 'local_gateway');
  assert.equal((await f.request('/twice', { token: result.data.token })).status, 200);
  assert.equal((await f.request('/api/auth/me', { token: result.data.token })).data.is_registration_owner, true);
  assert.equal((await f.request('/api/auth/admin/registration-requests', { token: result.data.token })).status, 200);
});

test('direct site login and normal SMS sessions retain SMS verification, while bad gateway headers never trigger a text', async t => {
  const f = await fixture(t);
  for (const headers of [{ 'x-wolfs-local-gateway': ID }, { ...proof(), 'x-wolfs-local-signature': '0'.repeat(64) }]) {
    assert.equal((await f.request('/api/auth/login', { signed: false, headers })).status, 403);
  }
  assert.equal(f.sms.length, 0);
  const direct = await f.request('/api/auth/login', { signed: false });
  assert.equal(direct.status, 200); assert.equal(direct.data.requires_second_factor, true); assert.equal(direct.data.token, undefined);
  assert.equal(f.sms.length, 1);
  const token = jwt.sign({ id: 1, auth_version: 0, mfa: 'sms_otp' }, f.env.JWT_SECRET);
  assert.equal((await f.request('/private', { token, signed: false })).status, 200);
  const ordinary = jwt.sign({ id: 1, auth_version: 0 }, f.env.JWT_SECRET);
  assert.equal((await f.request('/private', { token: ordinary, signed: false })).status, 403);
});

test('gateway configuration defaults disabled and malformed opt-in fails closed without sending SMS', async t => {
  for (const env of [{ AUTH_LOCAL_GATEWAY_ENABLED: undefined }, { AUTH_LOCAL_GATEWAY_ENABLED: 'false' }, { AUTH_LOCAL_GATEWAY_SECRET: 'invalid' }]) {
    const f = await fixture(t, { env });
    const result = await f.request();
    assert.equal(result.status, env.AUTH_LOCAL_GATEWAY_SECRET ? 503 : 403);
    assert.equal(f.sms.length, 0); assert.equal(result.data.token, undefined);
  }
});

test('active legacy accounts may use local passwords but blocked and registered-unverified accounts cannot bypass activation', async t => {
  const f = await fixture(t);
  const old = await f.request('/api/auth/login', { body: { email: 'old@example.test', password: PASSWORD } });
  assert.equal(old.status, 200);
  for (const status of ['registered_unverified', 'blocked']) {
    f.db.prepare('UPDATE users SET account_status=? WHERE id=2').run(status);
    const result = await f.request('/api/auth/login', { body: { email: 'other@example.test', password: PASSWORD } });
    assert.equal(result.status, 403); assert.equal(result.data.token, undefined);
  }
  const registration = await f.request('/api/auth/register', { method: 'POST', body: { email: 'unapproved@example.test', password: PASSWORD } });
  assert.equal(registration.status, 403); assert.equal(registration.data.code, 'APPROVAL_REQUIRED');
  assert.equal(f.sms.length, 0);
});

test('local session ID/audience, proof, authentication version and enabled configuration are enforced on every request', async t => {
  const f = await fixture(t);
  const login = await f.request(), token = login.data.token;
  for (const claims of [
    { id: 1, auth_version: 0, mfa: 'local_gateway', local_gateway_id: ID, aud: 'wrong' },
    { id: 1, auth_version: 0, mfa: 'local_gateway', local_gateway_id: 'other-gateway-machine', aud: gateway.gatewayAudience(ID) },
    { id: 1, auth_version: 0, mfa: 'local_gateway', local_gateway_id: ID, aud: gateway.gatewayAudience(ID), local_gateway_verified: true }
  ]) {
    const signed = jwt.sign(claims, f.env.JWT_SECRET);
    assert.equal((await f.request('/private', { token: signed, signed: false })).status, 403);
    if (claims.aud !== gateway.gatewayAudience(ID) || claims.local_gateway_id !== ID) assert.equal((await f.request('/private', { token: signed })).status, 403);
  }
  f.env.AUTH_SMS_REQUIRED = 'false';
  assert.equal((await f.request('/private', { token, signed: false })).status, 403);
  f.db.prepare('UPDATE users SET auth_version=1 WHERE id=1').run();
  assert.equal((await f.request('/private', { token })).status, 401);
  f.db.prepare('UPDATE users SET auth_version=0 WHERE id=1').run();
  f.env.AUTH_LOCAL_GATEWAY_ENABLED = 'false';
  assert.equal((await f.request('/private', { token })).status, 403);
  assert.equal(f.sms.length, 0);
});

test('owner authority requires the verified server actor and never follows an unauthenticated JWT-shaped object', async t => {
  const f = await fixture(t);
  const approvals = createRegistrationApprovalService({ db: f.db, env: f.env });
  const actor = { id: 1, auth_version: 0, mfa: 'local_gateway', local_gateway_id: ID, aud: gateway.gatewayAudience(ID) };
  assert.equal(approvals.isOwner(actor), false);
  assert.equal(approvals.isOwner({ ...actor, local_gateway_verified: true }), true);
  assert.equal(approvals.isOwner({ ...actor, local_gateway_verified: true, id: 2 }), false);
  assert.equal(approvals.isOwner({ ...actor, local_gateway_verified: true, local_gateway_id: 'wrong-gateway' }), false);
  assert.equal(approvals.isOwner({ id: 1, auth_version: 0, mfa: 'sms_otp' }), true);
});

test('a proof spent on a wrong password cannot be reused for another login and nonce persistence failures send no SMS', async t => {
  const f = await fixture(t), headers = proof();
  const failed = await f.request('/api/auth/login', { signed: false, headers, body: { email: 'owner@example.test', password: 'Wrong password' } });
  assert.equal(failed.status, 401);
  assert.equal((await f.request('/api/auth/login', { signed: false, headers })).status, 403);
  f.db.exec("CREATE TRIGGER fail_nonce BEFORE INSERT ON local_auth_gateway_nonces BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");
  const unavailable = await f.request();
  assert.equal(unavailable.status, 503); assert.equal(unavailable.data.code, 'LOCAL_GATEWAY_UNAVAILABLE');
  assert.equal(unavailable.data.token, undefined); assert.equal(f.sms.length, 0);
});
