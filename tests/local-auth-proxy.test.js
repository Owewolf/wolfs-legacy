'use strict';

// One complete proxy/auth integration: private temporary gateway configuration,
// trusted synthetic TLS, memory SQLite and a recording SMS transport. No app
// initialization, checkout database, production secrets or external requests.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const { once } = require('node:events');
const { execFileSync } = require('node:child_process');
const express = require('express');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { createFrontendServer } = require('../scripts/dev-frontend');
const { initLocalAuthGatewaySchema, gatewayAudience } = require('../server/local-auth-gateway');
const { initSmsOtpSchema } = require('../server/sms-otp');
const { initRegistrationApprovalSchema } = require('../server/registration-approval');

// Route modules may import the lazy default DB helper, but any accidental use
// must fail before it could open a persistent database.
require.cache[require.resolve('better-sqlite3')].exports = function MemoryDatabase(filename, ...args) {
  assert.equal(filename, ':memory:', 'only the isolated in-memory fixture may be opened');
  return new Database(filename, ...args);
};
const { createAuthRouter } = require('../server/routes/auth');
const { authenticateToken } = require('../server/middleware/auth');

async function listen(server, scheme = 'http') {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return scheme + '://127.0.0.1:' + server.address().port;
}
function requestJSON(origin, requestPath, { method = 'GET', body, token, ca, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(origin), bytes = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const request = (target.protocol === 'https:' ? https : http).request({
      hostname: target.hostname, port: target.port, method, path: requestPath,
      rejectUnauthorized: true, ...(ca ? { ca } : {}),
      headers: { ...(bytes ? { 'Content-Type': 'application/json', 'Content-Length': bytes.length } : {}),
        ...(token ? { Authorization: 'Bearer ' + token } : {}), ...headers }
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk)); response.on('error', reject);
      response.on('end', () => {
        try { resolve({ status: response.statusCode, headers: response.headers, data: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); }
        catch (error) { reject(error); }
      });
    });
    request.on('error', reject); request.end(bytes);
  });
}

test('real local proxy logs in without SMS over verified HTTPS and scopes its session away from direct production access', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wolfs-local-auth-proxy-'));
  fs.chmodSync(root, 0o700);
  let upstream, frontend, db;
  t.after(async () => {
    for (const server of [frontend, upstream]) if (server?.listening) {
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    }
    if (db?.open) db.close(); fs.rmSync(root, { recursive: true, force: true });
  });
  const certPath = path.join(root, 'cert.pem'), keyPath = path.join(root, 'key.pem');
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-keyout', keyPath, '-out', certPath, '-subj', '/CN=localhost',
      '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' });
  } catch (error) {
    if (error.code === 'ENOENT') { t.skip('OpenSSL unavailable for the isolated TLS fixture'); return; }
    throw error;
  }
  const ca = fs.readFileSync(certPath), gatewayId = 'ac'.repeat(16), secret = 'bd'.repeat(32);
  const password = 'SyntheticPrivateGatewayPassword123!';
  const env = { AUTH_LOCAL_GATEWAY_ENABLED: 'true', AUTH_LOCAL_GATEWAY_ID: gatewayId, AUTH_LOCAL_GATEWAY_SECRET: secret,
    AUTH_SMS_REQUIRED: 'true', JWT_SECRET: 'synthetic-proxy-jwt-key-never-production', OTP_HASH_KEY: 'synthetic-proxy-otp-key-never-production',
    ACCOUNT_APPROVAL_REQUIRED: 'true', ACCOUNT_APPROVAL_OWNER_USER_ID: '1', ACCOUNT_APPROVAL_OWNER_SMS_E164: '+27820000001',
    APP_BASE_URL: 'https://synthetic.example.test' };
  db = new Database(':memory:'); initLocalAuthGatewaySchema(db);
  db.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY,email TEXT UNIQUE,name TEXT,password_hash TEXT,
      sms_2fa_enabled INTEGER DEFAULT 0,sms_2fa_phone_e164 TEXT,sms_2fa_enrolled_at TEXT,totp_enabled INTEGER DEFAULT 0,
      created_at TEXT,last_check_in TEXT);
    CREATE TABLE dead_switch_config(id INTEGER PRIMARY KEY,user_id INTEGER UNIQUE);
    CREATE TABLE audit_log(id INTEGER PRIMARY KEY,user_id INTEGER,action TEXT,target_type TEXT,target_id INTEGER,
      detail TEXT,ip_address TEXT,created_at TEXT);`);
  initSmsOtpSchema(db); initRegistrationApprovalSchema(db);
  const insert = db.prepare('INSERT INTO users(id,email,name,password_hash,sms_2fa_enabled,sms_2fa_phone_e164) VALUES(?,?,?,?,1,?)');
  insert.run(1, 'synthetic-owner@example.test', 'Synthetic Owner', bcrypt.hashSync(password, 4), '+27820000001');
  insert.run(2, 'synthetic-inactive@example.test', 'Synthetic Inactive', bcrypt.hashSync(password, 4), '+27820000002');
  const sms = [], app = express(); app.use(express.json());
  app.locals.getDb = () => db; app.locals.authEnv = env;
  app.use('/api/auth', createAuthRouter({ dbGetter: () => db, env,
    auditWriter: (...args) => db.prepare('INSERT INTO audit_log(user_id,action,target_type,target_id,detail,ip_address) VALUES(?,?,?,?,?,?)')
      .run(...args.map(value => value ?? null)),
    smsProvider: { configured: true, simulated: false, async sendOtp(message) { sms.push(message); return {}; } }
  }));
  app.get('/api/protected', authenticateToken, (req, res) => res.json({ id: req.user.id, mfa: req.user.mfa,
    verified_gateway_actor: req.user.local_gateway_verified === true }));
  upstream = https.createServer({ key: fs.readFileSync(keyPath), cert: ca }, app);
  const upstreamOrigin = await listen(upstream, 'https');
  const privateRoot = path.join(root, 'private'), publicRoot = path.join(root, 'public');
  fs.mkdirSync(privateRoot, { mode: 0o700 }); fs.mkdirSync(publicRoot, { mode: 0o700 });
  fs.writeFileSync(path.join(publicRoot, 'index.html'), '<!doctype html><title>Synthetic local app</title>');
  const localAuthConfigPath = path.join(privateRoot, 'local-auth.json');
  fs.writeFileSync(localAuthConfigPath, JSON.stringify({ enabled: true, api_origin: upstreamOrigin,
    gateway_id: gatewayId, secret }), { mode: 0o600 });
  assert.equal(fs.statSync(privateRoot).mode & 0o7777, 0o700);
  assert.equal(fs.statSync(localAuthConfigPath).mode & 0o7777, 0o600);
  frontend = createFrontendServer({ apiTarget: upstreamOrigin, publicRoot, localAuthConfigPath, apiCa: ca });
  const localOrigin = await listen(frontend);
  const browserHeaders = { Origin: localOrigin, 'Sec-Fetch-Site': 'same-origin' };
  const usersBefore = db.prepare('SELECT * FROM users ORDER BY id').all();

  const login = await requestJSON(localOrigin, '/api/auth/login', { method: 'POST', headers: browserHeaders,
    body: { email: 'synthetic-owner@example.test', password } });
  assert.equal(login.status, 200); assert.equal(login.data.sms_required, false); assert.equal(sms.length, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sms_otp_challenges').get().n, 0);
  assert.deepEqual(db.prepare('SELECT * FROM users ORDER BY id').all(), usersBefore, 'local login preserves account and SMS enrollment');
  const claims = jwt.verify(login.data.token, env.JWT_SECRET);
  assert.equal(claims.mfa, 'local_gateway'); assert.equal(claims.local_gateway_id, gatewayId);
  assert.equal(claims.aud, gatewayAudience(gatewayId)); assert.equal(claims.local_gateway_verified, undefined);
  const protectedPath = '/api/protected?synthetic=%2f&order=2&order=1';
  const localRead = await requestJSON(localOrigin, protectedPath, { token: login.data.token, headers: browserHeaders });
  assert.equal(localRead.status, 200);
  assert.deepEqual(localRead.data, { id: 1, mfa: 'local_gateway', verified_gateway_actor: true });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM local_auth_gateway_nonces').get().n, 2, 'login and read use distinct durable proofs');
  for (const name of Object.keys(localRead.headers)) assert.ok(!name.startsWith('x-wolfs-local-'), 'gateway proofs never reach the browser');

  const stolenDirect = await requestJSON(upstreamOrigin, protectedPath, { ca, token: login.data.token });
  assert.equal(stolenDirect.status, 403); assert.equal(stolenDirect.data.code, 'LOCAL_GATEWAY_REQUIRED');
  const ordinaryLogin = await requestJSON(upstreamOrigin, '/api/auth/login', { ca, method: 'POST',
    body: { email: 'synthetic-owner@example.test', password } });
  assert.equal(ordinaryLogin.status, 200); assert.equal(ordinaryLogin.data.requires_second_factor, true);
  assert.equal(ordinaryLogin.data.token, undefined); assert.equal(sms.length, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sms_otp_challenges').get().n, 1);

  for (const status of ['blocked', 'registered_unverified']) {
    db.prepare('UPDATE users SET account_status=? WHERE id=2').run(status);
    const denied = await requestJSON(localOrigin, '/api/auth/login', { method: 'POST', headers: browserHeaders,
      body: { email: 'synthetic-inactive@example.test', password } });
    assert.equal(denied.status, 403); assert.equal(denied.data.token, undefined);
    assert.equal(db.prepare('SELECT account_status FROM users WHERE id=2').get().account_status, status);
  }
  assert.equal(sms.length, 1, 'local login and denied inactive accounts never send an SMS');
});
