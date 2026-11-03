'use strict';

// Machine-authenticated local gateway proofs. This module imports no app,
// database, environment file, transport or worker; signing is safe to share
// with the local frontend process. Never return these proofs to a browser.
const crypto = require('node:crypto');
const SKEW_MS = 30000;
const HEADERS = ['x-wolfs-local-gateway', 'x-wolfs-local-time', 'x-wolfs-local-nonce', 'x-wolfs-local-signature'];
const verifiedRequests = new WeakMap();
const gatewayAudience = id => 'local-gateway:' + id;
function failure(status = 403) {
  return Object.assign(new Error(status === 503 ? 'Local gateway authentication is unavailable' : 'Local gateway authentication is not authorised'), {
    status, code: status === 503 ? 'LOCAL_GATEWAY_UNAVAILABLE' : 'LOCAL_GATEWAY_INVALID'
  });
}
function gatewayConfiguration(env = process.env) {
  if (env.AUTH_LOCAL_GATEWAY_ENABLED !== 'true') return null;
  const id = env.AUTH_LOCAL_GATEWAY_ID, secret = env.AUTH_LOCAL_GATEWAY_SECRET;
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(id) || typeof secret !== 'string' || !/^[a-fA-F0-9]{64}$/.test(secret)) throw failure(503);
  return { id, secret };
}
function canonical({ gatewayId, timestamp, nonce, method, url, authorization = '' }) {
  return JSON.stringify(['v1', gatewayId, timestamp, nonce, method.toUpperCase(), url,
    crypto.createHash('sha256').update(authorization).digest('hex')]);
}
function signGatewayRequest({ gatewayId, secret, timestamp = String(Date.now()), nonce = crypto.randomBytes(16).toString('hex'), method, url, authorization = '' }) {
  const signature = crypto.createHmac('sha256', Buffer.from(secret, 'hex'))
    .update(canonical({ gatewayId, timestamp, nonce, method, url, authorization })).digest('hex');
  return { 'x-wolfs-local-gateway': gatewayId, 'x-wolfs-local-time': timestamp,
    'x-wolfs-local-nonce': nonce, 'x-wolfs-local-signature': signature };
}
function hasGatewayHeaders(req) { return HEADERS.some(name => req.headers?.[name] !== undefined); }
function initLocalAuthGatewaySchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS local_auth_gateway_nonces (
    gateway_id TEXT NOT NULL, nonce TEXT NOT NULL, expires_at INTEGER NOT NULL,
    PRIMARY KEY(gateway_id,nonce)
  ); CREATE INDEX IF NOT EXISTS idx_local_gateway_nonce_expiry ON local_auth_gateway_nonces(expires_at);`);
}
function verifyGatewayRequest(req, { db, env = process.env, now = Date.now } = {}) {
  if (!hasGatewayHeaders(req)) return null;
  const counts = new Map();
  for (let index = 0; index < (req.rawHeaders || []).length; index += 2) {
    const name = String(req.rawHeaders[index]).toLowerCase();
    if (name === 'authorization' || HEADERS.includes(name)) {
      counts.set(name, (counts.get(name) || 0) + 1);
      if (counts.get(name) > 1) throw failure();
    }
  }
  const config = gatewayConfiguration(env);
  if (!config) throw failure();
  const memo = verifiedRequests.get(req);
  if (memo?.gatewayId === config.id && memo.secret === config.secret) return { gatewayId: memo.gatewayId };
  const gatewayId = req.headers[HEADERS[0]], timestamp = req.headers[HEADERS[1]], nonce = req.headers[HEADERS[2]], signature = req.headers[HEADERS[3]];
  const clock = now();
  if (gatewayId !== config.id || typeof timestamp !== 'string' || !/^\d{13}$/.test(timestamp) ||
      typeof nonce !== 'string' || !/^[a-f0-9]{32}$/.test(nonce) || typeof signature !== 'string' || !/^[a-f0-9]{64}$/.test(signature) ||
      !Number.isSafeInteger(clock) || !Number.isSafeInteger(Number(timestamp)) || Math.abs(clock - Number(timestamp)) > SKEW_MS) throw failure();
  const authorization = req.headers.authorization ?? '';
  if (typeof authorization !== 'string') throw failure();
  const expected = crypto.createHmac('sha256', Buffer.from(config.secret, 'hex'))
    .update(canonical({ gatewayId, timestamp, nonce, method: req.method, url: req.originalUrl || req.url, authorization })).digest();
  if (!crypto.timingSafeEqual(expected, Buffer.from(signature, 'hex'))) throw failure();
  try {
    db.transaction(() => {
      db.prepare('DELETE FROM local_auth_gateway_nonces WHERE expires_at < ?').run(clock);
      // Future-dated proofs remain usable through timestamp+skew; never prune
      // their consumed nonce using clock+skew instead.
      const stored = db.prepare('INSERT OR IGNORE INTO local_auth_gateway_nonces(gateway_id,nonce,expires_at) VALUES(?,?,?)')
        .run(gatewayId, nonce, Number(timestamp) + SKEW_MS);
      if (!stored.changes) throw failure();
    }).immediate();
  } catch (error) {
    if (error.code === 'LOCAL_GATEWAY_INVALID') throw error;
    throw failure(503);
  }
  verifiedRequests.set(req, { gatewayId, secret: config.secret });
  return { gatewayId };
}
function isVerifiedGatewayActor(user, env = process.env) {
  let config;
  try { config = gatewayConfiguration(env); } catch { return false; }
  return !!(config && user?.mfa === 'local_gateway' && user.local_gateway_verified === true &&
    user.local_gateway_id === config.id && user.aud === gatewayAudience(config.id));
}
module.exports = { SKEW_MS, gatewayAudience, gatewayConfiguration, hasGatewayHeaders, initLocalAuthGatewaySchema,
  signGatewayRequest, verifyGatewayRequest, isVerifiedGatewayActor };
