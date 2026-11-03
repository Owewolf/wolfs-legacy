const jwt = require('jsonwebtoken');
const { getDb } = require('../db');
const { gatewayAudience, verifyGatewayRequest } = require('../local-auth-gateway');

function authenticateToken(req, res, next) {
  const header = req.headers['authorization'];
  const token = header && header.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Authentication required' });

  try {
    const env = req.app?.locals?.authEnv || process.env;
    req.user = jwt.verify(token, env.JWT_SECRET);
    // This flag is exclusively set after a fresh machine proof, never trusted
    // from a JWT claim, request body or browser header.
    delete req.user.local_gateway_verified;
    if (req.user.purpose) return res.status(403).json({ error: 'A sign-in session is required', code: 'PHONE_SETUP_TOKEN_FORBIDDEN' });
    const dbGetter = typeof req.app?.locals?.getDb === 'function' ? req.app.locals.getDb : getDb;
    const db = dbGetter();
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!user) return res.status(401).json({ error: 'Authentication required' });
    if (user.account_status === 'blocked') return res.status(403).json({ error: 'Account access is blocked', code: 'ACCOUNT_BLOCKED' });
    if (user.account_status && user.account_status !== 'active') return res.status(403).json({ error: 'Complete mobile verification before signing in', code: 'SMS_VERIFICATION_REQUIRED' });
    if ((req.user.auth_version ?? 0) !== (user.auth_version ?? 0)) return res.status(401).json({ error: 'Sign in again', code: 'SESSION_REVOKED' });
    if (req.user.mfa === 'local_gateway') {
      const proof = verifyGatewayRequest(req, { db, env });
      if (!proof || req.user.local_gateway_id !== proof.gatewayId || req.user.aud !== gatewayAudience(proof.gatewayId)) {
        return res.status(403).json({ error: 'This session requires the authorised local gateway', code: 'LOCAL_GATEWAY_REQUIRED' });
      }
      req.user.local_gateway_verified = true;
      next();
      return;
    }
    const required = env.AUTH_SMS_REQUIRED === 'true';
    if ((required && !user.sms_2fa_enabled) || ((required || user.sms_2fa_enabled) && req.user.mfa !== 'sms_otp')) {
      return res.status(403).json({ error: 'Second-factor verification required', code: 'SMS_VERIFICATION_REQUIRED' });
    }
    next();
  } catch (error) {
    if (error.code === 'LOCAL_GATEWAY_INVALID' || error.code === 'LOCAL_GATEWAY_UNAVAILABLE') return res.status(error.status).json({ error: error.message, code: error.code });
    return res.status(403).json({ error: 'Invalid or expired token' });
  }
}

module.exports = { authenticateToken };
