const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { getDb, audit } = require('../db');
const { authenticateToken } = require('../middleware/auth');
const { createSmsProvider } = require('../sms-provider');
const { createSmsOtpService } = require('../sms-otp');
const { validateEmail, validateString, validationError } = require('../validate');

function createAuthRouter({ dbGetter = getDb, auditWriter = audit, env = process.env, now = Date.now, smsProvider = createSmsProvider(env) } = {}) {
  const router = express.Router();

  const challengeRate = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 40,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'Too many second-factor requests, please try again later' }
  });

  function service(db) {
    return createSmsOtpService({ db, env, now, smsSender: smsProvider });
  }

  function createToken(user, secondFactorMethod = null) {
    const payload = { id: user.id, email: user.email, name: user.name };
    if (secondFactorMethod) payload.mfa = secondFactorMethod;
    return jwt.sign(payload, env.JWT_SECRET, { expiresIn: '24h' });
  }

  async function verifyPassword(user, password) {
    return user && typeof password === 'string' && await bcrypt.compare(password, user.password_hash);
  }

  function throttleOrReject(res, check) {
    if (!check.blocked) return false;
    res.status(429).json({ error: 'Too many attempts, please try again later' });
    return true;
  }

  function challengeErrorMessage(reason) {
    if (reason === 'cooldown') return 'Please wait before requesting another code';
    if (reason === 'expired') return 'The code has expired. Start sign-in again.';
    if (reason === 'locked') return 'Too many failed attempts. Start sign-in again.';
    if (reason === 'already_used') return 'This challenge was already used';
    if (reason === 'invalid_otp' || reason === 'invalid_recovery_code') return 'Invalid verification code';
    return 'Verification could not be completed';
  }

  router.post('/register', async (req, res) => {
    try {
      const { email, password, name } = req.body;
      if (!email || !password || !name) return validationError(res, 'All fields required');
      if (!validateEmail(email)) return validationError(res, 'Invalid email format');
      if (!validateString(name, 1, 200)) return validationError(res, 'Name must be 1-200 characters');
      if (!validateString(password, 8, 128)) return validationError(res, 'Password must be 8-128 characters');

      const db = dbGetter();
      const cleanEmail = email.toLowerCase().trim();
      if (db.prepare('SELECT id FROM users WHERE email = ?').get(cleanEmail)) {
        return res.status(409).json({ error: 'Email already registered' });
      }

      const hash = await bcrypt.hash(password, 12);
      const result = db.prepare('INSERT INTO users (email, password_hash, name) VALUES (?, ?, ?)').run(cleanEmail, hash, name.trim());
      db.prepare('INSERT INTO dead_switch_config (user_id) VALUES (?)').run(result.lastInsertRowid);

      auditWriter(result.lastInsertRowid, 'register', 'user', result.lastInsertRowid, null, req.ip);
      return res.status(201).json({
        success: true,
        message: 'Account created. Sign in to continue.',
        user: { id: result.lastInsertRowid, email: cleanEmail, name: name.trim() }
      });
    } catch {
      return res.status(500).json({ error: 'Registration failed' });
    }
  });

  router.post('/login', async (req, res) => {
    try {
      const { email, password } = req.body;
      if (!email || !password) return validationError(res, 'Email and password required');

      const db = dbGetter();
      const smsOtp = service(db);
      const cleanEmail = email.toLowerCase().trim();
      const user = db.prepare('SELECT * FROM users WHERE email = ?').get(cleanEmail);
      if (!user || !(await verifyPassword(user, password))) {
        auditWriter(null, 'login_failed', 'user', null, cleanEmail, req.ip);
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      if (!user.sms_2fa_enabled) {
        auditWriter(user.id, 'login', 'user', user.id, null, req.ip);
        const token = createToken(user, null);
        return res.json({ token, user: { id: user.id, email: user.email, name: user.name } });
      }

      const throttle = smsOtp.throttle('login_challenge_start', { userId: user.id, ipAddress: req.ip, maxUser: 10, maxIp: 50 });
      if (throttleOrReject(res, throttle)) {
        auditWriter(user.id, 'login_challenge_throttled', 'user', user.id, 'start', req.ip);
        return;
      }

      if (!smsProvider.configured) {
        auditWriter(user.id, 'login_2fa_unavailable', 'user', user.id, null, req.ip);
        return res.status(503).json({ error: 'Second factor is temporarily unavailable' });
      }

      const issued = await smsOtp.issueLoginChallenge({ userId: user.id, phone: user.sms_2fa_phone_e164 });
      if (!issued.ok) {
        auditWriter(user.id, 'login_2fa_unavailable', 'user', user.id, issued.reason, req.ip);
        return res.status(503).json({ error: 'Second factor is temporarily unavailable' });
      }

      auditWriter(user.id, 'login_challenge_issued', 'user', user.id, null, req.ip);
      return res.json({
        requires_second_factor: true,
        challenge_id: issued.challenge.challenge_id,
        challenge_token: issued.challenge.challenge_token,
        expires_at: issued.challenge.expires_at,
        resend_available_at: issued.challenge.resend_available_at,
        masked_phone: issued.challenge.masked_phone,
        recovery_code_allowed: true
      });
    } catch {
      return res.status(500).json({ error: 'Login failed' });
    }
  });

  router.post('/login/challenge/verify', challengeRate, (req, res) => {
    try {
      const { challenge_id: challengeId, challenge_token: challengeToken, otp, recovery_code: recoveryCode } = req.body || {};
      if (!challengeId || !challengeToken) return validationError(res, 'Challenge details required');
      if (!otp && !recoveryCode) return validationError(res, 'A verification code is required');

      const db = dbGetter();
      const smsOtp = service(db);
      const result = smsOtp.verifyLoginChallenge({ challengeId, challengeToken, otp, recoveryCode });
      if (!result.ok) {
        auditWriter(null, 'login_challenge_failed', 'user', result.user_id || null, result.reason, req.ip);
        const status = ['forbidden', 'not_found'].includes(result.reason) ? 403 : 400;
        return res.status(status).json({
          error: challengeErrorMessage(result.reason),
          reason: result.reason,
          resend_available_at: result.resend_available_at || null
        });
      }

      const user = db.prepare('SELECT id, email, name FROM users WHERE id=?').get(result.user_id);
      if (!user) return res.status(404).json({ error: 'User not found' });

      auditWriter(user.id, 'login', 'user', user.id, result.method, req.ip);
      const token = createToken(user, 'sms_otp');
      return res.json({ token, user });
    } catch {
      return res.status(500).json({ error: 'Verification failed' });
    }
  });

  router.post('/login/challenge/resend', challengeRate, async (req, res) => {
    try {
      const { challenge_id: challengeId, challenge_token: challengeToken } = req.body || {};
      if (!challengeId || !challengeToken) return validationError(res, 'Challenge details required');

      const db = dbGetter();
      const smsOtp = service(db);
      const throttle = smsOtp.throttle('login_challenge_resend', { ipAddress: req.ip, maxUser: 1000, maxIp: 80 });
      if (throttleOrReject(res, throttle)) return;

      const result = await smsOtp.resendChallenge({ challengeId, challengeToken, purpose: 'login' });
      if (!result.ok) {
        const status = result.reason === 'cooldown' ? 429 : ['forbidden', 'not_found'].includes(result.reason) ? 403 : 400;
        return res.status(status).json({
          error: challengeErrorMessage(result.reason),
          reason: result.reason,
          resend_available_at: result.resend_available_at || null
        });
      }

      return res.json(result);
    } catch {
      return res.status(500).json({ error: 'Resend failed' });
    }
  });

  router.get('/me', authenticateToken, (req, res) => {
    const db = dbGetter();
    const user = db.prepare('SELECT id, email, name, totp_enabled, sms_2fa_enabled, created_at, last_check_in FROM users WHERE id = ?').get(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    return res.json(user);
  });

  router.put('/password', authenticateToken, async (req, res) => {
    try {
      const { current_password: currentPassword, new_password: newPassword } = req.body;
      if (!currentPassword || !newPassword) return validationError(res, 'Both current and new password required');
      if (!validateString(newPassword, 8, 128)) return validationError(res, 'New password must be 8-128 characters');

      const db = dbGetter();
      const user = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
      if (!(await bcrypt.compare(currentPassword, user.password_hash))) {
        return res.status(401).json({ error: 'Current password is incorrect' });
      }

      const hash = await bcrypt.hash(newPassword, 12);
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, req.user.id);
      auditWriter(req.user.id, 'password_change', 'user', req.user.id, null, req.ip);
      return res.json({ success: true });
    } catch {
      return res.status(500).json({ error: 'Password change failed' });
    }
  });

  router.get('/2fa/status', authenticateToken, (req, res) => {
    try {
      const db = dbGetter();
      const smsOtp = service(db);
      const status = smsOtp.status(req.user.id);
      if (!status) return res.status(404).json({ error: 'User not found' });
      return res.json(status);
    } catch {
      return res.status(500).json({ error: 'Could not load 2FA status' });
    }
  });

  router.post('/2fa/enroll/start', authenticateToken, challengeRate, async (req, res) => {
    try {
      const { phone, current_password: currentPassword } = req.body || {};
      if (!phone || !currentPassword) return validationError(res, 'Phone and current password are required');

      const db = dbGetter();
      const smsOtp = service(db);
      const user = db.prepare('SELECT id, password_hash FROM users WHERE id=?').get(req.user.id);
      if (!(await verifyPassword(user, currentPassword))) {
        return res.status(401).json({ error: 'Current password is incorrect' });
      }

      const throttle = smsOtp.throttle('enrollment_start', { userId: req.user.id, ipAddress: req.ip, maxUser: 6, maxIp: 40 });
      if (throttleOrReject(res, throttle)) {
        auditWriter(req.user.id, 'sms_2fa_enroll_throttled', 'user', req.user.id, 'start', req.ip);
        return;
      }

      if (!smsProvider.configured) {
        return res.status(503).json({ error: 'SMS transport is not configured' });
      }

      const started = await smsOtp.startEnrollment({ userId: req.user.id, phone });
      if (!started.ok) {
        return res.status(started.reason === 'invalid_phone' ? 400 : 503).json({
          error: started.reason === 'invalid_phone'
            ? 'Phone must be in E.164 format (for example +27821234567)'
            : 'SMS delivery is unavailable'
        });
      }

      auditWriter(req.user.id, 'sms_2fa_enroll_started', 'user', req.user.id, null, req.ip);
      return res.json(started.challenge);
    } catch {
      return res.status(500).json({ error: 'Could not start phone enrollment' });
    }
  });

  router.post('/2fa/enroll/verify', authenticateToken, challengeRate, (req, res) => {
    try {
      const { challenge_id: challengeId, challenge_token: challengeToken, otp } = req.body || {};
      if (!challengeId || !challengeToken || !otp) return validationError(res, 'Challenge details and code are required');

      const db = dbGetter();
      const smsOtp = service(db);
      const result = smsOtp.completeEnrollment({ userId: req.user.id, challengeId, challengeToken, otp });
      if (!result.ok) {
        const status = ['forbidden', 'not_found'].includes(result.reason) ? 403 : 400;
        auditWriter(req.user.id, 'sms_2fa_enroll_failed', 'user', req.user.id, result.reason, req.ip);
        return res.status(status).json({ error: challengeErrorMessage(result.reason), reason: result.reason });
      }

      const user = db.prepare('SELECT id, email, name FROM users WHERE id=?').get(req.user.id);
      if (!user) return res.status(404).json({ error: 'User not found' });
      auditWriter(req.user.id, 'sms_2fa_enabled', 'user', req.user.id, null, req.ip);
      return res.json({
        success: true,
        masked_phone: smsOtp.maskPhone(result.phone),
        recovery_codes: result.recovery_codes,
        token: createToken(user, 'sms_otp'),
        user
      });
    } catch {
      return res.status(500).json({ error: 'Could not verify enrollment code' });
    }
  });

  router.post('/2fa/enroll/resend', authenticateToken, challengeRate, async (req, res) => {
    try {
      const { challenge_id: challengeId, challenge_token: challengeToken } = req.body || {};
      if (!challengeId || !challengeToken) return validationError(res, 'Challenge details required');

      const db = dbGetter();
      const smsOtp = service(db);
      const throttle = smsOtp.throttle('enrollment_resend', { userId: req.user.id, ipAddress: req.ip, maxUser: 12, maxIp: 80 });
      if (throttleOrReject(res, throttle)) return;

      const result = await smsOtp.resendChallenge({ challengeId, challengeToken, purpose: 'enrollment', userId: req.user.id });
      if (!result.ok) {
        const status = result.reason === 'cooldown' ? 429 : ['forbidden', 'not_found'].includes(result.reason) ? 403 : 400;
        return res.status(status).json({
          error: challengeErrorMessage(result.reason),
          reason: result.reason,
          resend_available_at: result.resend_available_at || null
        });
      }

      return res.json(result);
    } catch {
      return res.status(500).json({ error: 'Resend failed' });
    }
  });

  router.post('/2fa/recovery/regenerate', authenticateToken, challengeRate, async (req, res) => {
    try {
      const { current_password: currentPassword } = req.body || {};
      if (!currentPassword) return validationError(res, 'Current password is required');

      const db = dbGetter();
      const smsOtp = service(db);
      const user = db.prepare('SELECT id, password_hash FROM users WHERE id=?').get(req.user.id);
      if (!(await verifyPassword(user, currentPassword))) {
        return res.status(401).json({ error: 'Current password is incorrect' });
      }

      const status = smsOtp.status(req.user.id);
      if (!status?.enabled) return res.status(400).json({ error: 'SMS 2FA is not enabled' });

      const codes = smsOtp.regenerateRecoveryCodes(req.user.id);
      auditWriter(req.user.id, 'sms_2fa_recovery_rotated', 'user', req.user.id, null, req.ip);
      return res.json({ recovery_codes: codes });
    } catch {
      return res.status(500).json({ error: 'Could not regenerate recovery codes' });
    }
  });

  router.post('/2fa/disable', authenticateToken, challengeRate, async (req, res) => {
    try {
      const { current_password: currentPassword, recovery_code: recoveryCode } = req.body || {};
      if (!currentPassword || !recoveryCode) {
        return validationError(res, 'Current password and a recovery code are required');
      }

      const db = dbGetter();
      const smsOtp = service(db);
      const user = db.prepare('SELECT id, password_hash FROM users WHERE id=?').get(req.user.id);
      if (!(await verifyPassword(user, currentPassword))) {
        return res.status(401).json({ error: 'Current password is incorrect' });
      }

      const status = smsOtp.status(req.user.id);
      if (!status?.enabled) return res.status(400).json({ error: 'SMS 2FA is not enabled' });

      if (!smsOtp.consumeRecoveryCode(req.user.id, recoveryCode)) {
        auditWriter(req.user.id, 'sms_2fa_disable_failed', 'user', req.user.id, 'invalid_recovery_code', req.ip);
        return res.status(400).json({ error: 'Invalid recovery code' });
      }

      smsOtp.disable2fa(req.user.id);
      auditWriter(req.user.id, 'sms_2fa_disabled', 'user', req.user.id, null, req.ip);
      return res.json({ success: true });
    } catch {
      return res.status(500).json({ error: 'Could not disable SMS 2FA' });
    }
  });

  return router;
}

module.exports = createAuthRouter();
module.exports.createAuthRouter = createAuthRouter;
