const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('node:crypto');
const rateLimit = require('express-rate-limit');
const { getDb, audit } = require('../db');
const { authenticateToken } = require('../middleware/auth');
const { createSmsProvider } = require('../sms-provider');
const { createSmsOtpService } = require('../sms-otp');
const { smsAuthRequired, normalizeAuthPhone, resolveSavedPhone } = require('../sms-auth-policy');
const { validateString, validationError } = require('../validate');
const { createRegistrationApprovalService } = require('../registration-approval');
const { createRegistrationApprovalRouter } = require('./registration-approval');
const { gatewayAudience, verifyGatewayRequest } = require('../local-auth-gateway');

function createAuthRouter({ dbGetter = getDb, auditWriter = audit, env = process.env, now = Date.now, smsProvider = createSmsProvider(env), decryptFields } = {}) {
  const router = express.Router();
  router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  const approval = db => createRegistrationApprovalService({ db, env, now, smsSender: smsProvider, decryptFields, auditWriter });
  router.use(createRegistrationApprovalRouter({ dbGetter, auditWriter, env, now, smsProvider, decryptFields }));

  const challengeRate = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 40,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'Too many second-factor requests, please try again later' }
  });

  function service(db) {
    return createSmsOtpService({
      db, env, now, smsSender: smsProvider,
      loginPhoneResolver: user => resolveSavedPhone(db, user, env, decryptFields).phone,
      accountGuard: (user, details) => accountAccess(db, user, details),
      onLoginVerified: ({ user }) => {
        if (user.account_status === 'registered_unverified') {
          db.prepare("UPDATE users SET account_status='active' WHERE id=? AND account_status='registered_unverified'").run(user.id);
          auditWriter(user.id, 'registration_activated', 'user', user.id, null, null);
        }
      }
    });
  }

  function accountAccess(db, user, { phone = null, purpose = 'login' } = {}) {
    const access = approval(db).accountAccess(user);
    if (!access.ok) return access;
    const currentPhone = resolveSavedPhone(db, user, env, decryptFields).phone;
    if (user.account_status === 'registered_unverified' && phone && phone !== currentPhone) return { ok: false, reason: 'phone_changed' };
    if (purpose === 'enrollment' && phone && phone !== currentPhone) {
      if (String(user.id) === String(env.ACCOUNT_APPROVAL_OWNER_USER_ID)) return { ok: false, reason: 'owner_phone_protected' };
      if (approval(db).isDenied(null, phone) || approval(db).identityConflict(null, phone, user.id)) return { ok: false, reason: 'contact_unavailable' };
    }
    return { ok: true };
  }

  function rejectAccount(res, access) {
    if (access.ok) return false;
    res.status(403).json({ error: 'Account access is unavailable', code: access.reason === 'account_blocked' ? 'ACCOUNT_BLOCKED' : 'APPROVAL_REQUIRED' });
    return true;
  }

  function publicUser(db, user, mfa = null, gateway = null) {
    const actor = { ...user, mfa, ...(gateway ? { local_gateway_id: gateway.gatewayId,
      aud: gatewayAudience(gateway.gatewayId), local_gateway_verified: true } : {}) };
    return { id: user.id, email: user.email, name: user.name, is_registration_owner: approval(db).isOwner(actor) };
  }

  function createToken(user, secondFactorMethod = null, gateway = null) {
    const payload = { id: user.id, email: user.email, name: user.name, auth_version: user.auth_version ?? 0 };
    if (secondFactorMethod) payload.mfa = secondFactorMethod;
    if (gateway) { payload.local_gateway_id = gateway.gatewayId; payload.aud = gatewayAudience(gateway.gatewayId); }
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
    if (reason === 'phone_changed') return 'The saved mobile number has changed. Start sign-in again.';
    if (reason === 'invalid_otp' || reason === 'invalid_recovery_code') return 'Invalid verification code';
    return 'Verification could not be completed';
  }

  function challengeResponse(issued, user) {
    return {
      requires_second_factor: true,
      ...issued.challenge,
      recovery_code_allowed: !!user.sms_2fa_enabled
    };
  }

  function setupPasswordBinding(user) {
    return crypto.createHmac('sha256', env.JWT_SECRET).update(`sms-setup:${user.password_hash}`).digest('hex');
  }

  function phoneSetupResponse(user) {
    const expiresAt = new Date(now() + 5 * 60 * 1000).toISOString();
    const setupToken = jwt.sign({
      id: user.id, purpose: 'sms_phone_setup', password_binding: setupPasswordBinding(user),
      iat: Math.floor(now() / 1000), exp: Math.floor(new Date(expiresAt).getTime() / 1000)
    }, env.JWT_SECRET);
    return { requires_phone_setup: true, setup_token: setupToken, expires_at: expiresAt };
  }

  router.post('/register', async (req, res) => {
    try {
      const { invitation_token: invitationToken, password, email, phone, name } = req.body || {};
      if (!invitationToken) return res.status(403).json({ error: 'Owner approval is required before creating an account', code: 'APPROVAL_REQUIRED' });
      if (!validateString(password, 8, 128)) return validationError(res, 'Password must be 8-128 characters');
      const db = dbGetter();
      const approvals = approval(db);
      const validated = approvals.validateInvitation({ invitationToken, email, phone });
      if (!validated.ok) return res.status(403).json({ error: 'This registration invitation is unavailable', code: validated.reason.toUpperCase() });
      if (name !== undefined && name !== validated.request.name) return validationError(res, 'Use the identity approved in your invitation');
      if (!smsProvider.configured) return res.status(503).json({ error: 'SMS verification is temporarily unavailable. Please try again later.' });

      const hash = await bcrypt.hash(password, 12);
      const userId = db.transaction(() => {
        // Revalidate after password hashing, under the same write lock as
        // account creation and one-use invitation consumption.
        const eligible = approvals.validateInvitation({ invitationToken, email, phone });
        if (!eligible.ok) throw Object.assign(new Error('Invitation unavailable'), { invitationReason: eligible.reason });
        const applicant = eligible.request;
        const result = db.prepare("INSERT INTO users (email,password_hash,name,sms_2fa_phone_e164,account_status) VALUES (?,?,?,?,'registered_unverified')")
          .run(applicant.email, hash, applicant.name, applicant.phone_e164);
        const id = Number(result.lastInsertRowid);
        const consumed = approvals.consumeInvitation({ invitationToken, userId: id });
        if (!consumed.ok) throw Object.assign(new Error('Invitation unavailable'), { invitationReason: consumed.reason });
        db.prepare('INSERT INTO dead_switch_config (user_id) VALUES (?)').run(id);
        return id;
      }).immediate();
      const user = db.prepare('SELECT * FROM users WHERE id=?').get(userId);
      const issued = await service(db).issueLoginChallenge({ userId, phone: user.sms_2fa_phone_e164 });
      if (!issued.ok) return res.status(503).json({
        error: 'Registration approved, but the SMS code could not be sent. Sign in to retry verification.',
        account_created: true
      });
      auditWriter(userId, 'login_challenge_issued', 'user', userId, 'registration', req.ip);
      return res.status(201).json({ account_created: true, ...challengeResponse(issued, user) });
    } catch (error) {
      if (error.invitationReason) return res.status(403).json({ error: 'This registration invitation is unavailable', code: error.invitationReason.toUpperCase() });
      return res.status(500).json({ error: 'Registration failed' });
    }
  });

  router.post('/login', async (req, res) => {
    try {
      const db = dbGetter();
      const gateway = verifyGatewayRequest(req, { db, env, now });
      const { email, password } = req.body;
      if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) return validationError(res, 'Email and password required');

      const smsOtp = service(db);
      const cleanEmail = email.toLowerCase().trim();
      const user = db.prepare('SELECT * FROM users WHERE email = ?').get(cleanEmail);
      if (!user || !(await verifyPassword(user, password))) {
        auditWriter(null, 'login_failed', 'user', null, cleanEmail, req.ip);
        return res.status(401).json({ error: 'Invalid credentials' });
      }
      const currentUser = db.prepare('SELECT * FROM users WHERE id=?').get(user.id);
      if (!currentUser || currentUser.password_hash !== user.password_hash) return res.status(401).json({ error: 'Sign in again' });
      if (rejectAccount(res, accountAccess(db, currentUser))) return;

      if (gateway) {
        if (currentUser.account_status !== 'active') return res.status(403).json({ error: 'Complete account activation before signing in', code: 'APPROVAL_REQUIRED' });
        auditWriter(user.id, 'login_local_gateway', 'user', user.id, null, req.ip);
        return res.json({ sms_required: false, token: createToken(currentUser, 'local_gateway', gateway),
          user: publicUser(db, currentUser, 'local_gateway', gateway) });
      }

      if (!smsAuthRequired(env) && !user.sms_2fa_enabled && user.account_status !== 'registered_unverified') {
        auditWriter(user.id, 'login', 'user', user.id, null, req.ip);
        const token = createToken(currentUser, null);
        return res.json({ sms_required: false, token, user: publicUser(db, currentUser) });
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

      const resolvedPhone = resolveSavedPhone(db, user, env, decryptFields);
      if (!resolvedPhone.phone) {
        if (user.sms_2fa_enabled) return res.status(503).json({ error: 'Your enrolled mobile number is unavailable. Contact support to recover access.' });
        return res.json(phoneSetupResponse(user));
      }
      const issued = await smsOtp.issueLoginChallenge({ userId: user.id, phone: resolvedPhone.phone });
      if (!issued.ok) {
        auditWriter(user.id, 'login_2fa_unavailable', 'user', user.id, issued.reason, req.ip);
        return res.status(503).json({ error: 'Second factor is temporarily unavailable' });
      }

      auditWriter(user.id, 'login_challenge_issued', 'user', user.id, null, req.ip);
      return res.json(challengeResponse(issued, user));
    } catch (error) {
      if (error.code === 'LOCAL_GATEWAY_INVALID' || error.code === 'LOCAL_GATEWAY_UNAVAILABLE') return res.status(error.status).json({ error: error.message, code: error.code });
      return res.status(500).json({ error: 'Login failed' });
    }
  });

  router.post('/login/phone', challengeRate, async (req, res) => {
    try {
      if (!smsAuthRequired(env)) return res.status(403).json({ error: 'Mobile setup is unavailable for this sign-in' });
      const { setup_token: setupToken, phone } = req.body || {};
      const normalizedPhone = normalizeAuthPhone(phone, env);
      if (!setupToken || !normalizedPhone) return validationError(res, 'A valid mobile number and setup details are required');
      let setup;
      try { setup = jwt.verify(setupToken, env.JWT_SECRET, { clockTimestamp: Math.floor(now() / 1000) }); }
      catch { return res.status(403).json({ error: 'Mobile setup has expired. Start sign-in again.' }); }
      if (setup.purpose !== 'sms_phone_setup' || !Number.isSafeInteger(setup.id)) {
        return res.status(403).json({ error: 'Invalid mobile setup details. Start sign-in again.' });
      }
      const db = dbGetter();
      const user = db.prepare('SELECT * FROM users WHERE id=?').get(setup.id);
      if (!user || user.sms_2fa_enabled || setup.password_binding !== setupPasswordBinding(user)) {
        return res.status(403).json({ error: 'Mobile setup is no longer available. Start sign-in again.' });
      }
      if (rejectAccount(res, accountAccess(db, user, { phone: normalizedPhone, purpose: 'enrollment' }))) return;
      const smsOtp = service(db);
      if (throttleOrReject(res, smsOtp.throttle('login_phone_setup', { userId: user.id, ipAddress: req.ip, maxUser: 6, maxIp: 40 }))) return;
      if (!smsProvider.configured) return res.status(503).json({ error: 'SMS verification is temporarily unavailable' });
      const updated = db.prepare('UPDATE users SET sms_2fa_phone_e164=? WHERE id=? AND sms_2fa_enabled=0 AND password_hash=?').run(normalizedPhone, user.id, user.password_hash);
      if (updated.changes !== 1) return res.status(403).json({ error: 'Mobile setup is no longer available. Start sign-in again.' });
      const issued = await smsOtp.issueLoginChallenge({ userId: user.id, phone: normalizedPhone });
      if (!issued.ok) return res.status(503).json({ error: 'The SMS code could not be sent. Sign in to request a new code.' });
      auditWriter(user.id, 'login_phone_setup_started', 'user', user.id, null, req.ip);
      return res.json(challengeResponse(issued, user));
    } catch {
      return res.status(500).json({ error: 'Could not set up your mobile number' });
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

      const user = db.prepare('SELECT * FROM users WHERE id=?').get(result.user_id);
      if (!user) return res.status(404).json({ error: 'User not found' });

      if (result.recovery_codes) auditWriter(user.id, 'sms_2fa_enabled', 'user', user.id, 'sign_in', req.ip);
      auditWriter(user.id, 'login', 'user', user.id, result.method, req.ip);
      const token = createToken(user, 'sms_otp');
      return res.json({ token, user: publicUser(db, user, 'sms_otp'),
        ...(result.recovery_codes ? { recovery_codes: result.recovery_codes, masked_phone: smsOtp.maskPhone(result.phone) } : {})
      });
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
    return res.json({ ...user, is_registration_owner: approval(db).isOwner(req.user) });
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
      return res.json({ ...status, transport_configured: !!smsProvider.configured, simulated: !!smsProvider.simulated });
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
        if (['account_blocked', 'approval_required', 'contact_unavailable', 'owner_phone_protected', 'phone_changed'].includes(started.reason)) {
          return res.status(403).json({ error: 'This mobile number is unavailable for enrollment', code: started.reason.toUpperCase() });
        }
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

      const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
      if (!user) return res.status(404).json({ error: 'User not found' });
      auditWriter(req.user.id, 'sms_2fa_enabled', 'user', req.user.id, null, req.ip);
      return res.json({
        success: true,
        masked_phone: smsOtp.maskPhone(result.phone),
        recovery_codes: result.recovery_codes,
        token: createToken(user, 'sms_otp'),
        user: publicUser(db, user, 'sms_otp')
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
      if (smsAuthRequired(env) || String(req.user.id) === String(env.ACCOUNT_APPROVAL_OWNER_USER_ID)) return res.status(403).json({ error: 'SMS authentication is required and cannot be disabled' });
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
