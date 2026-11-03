const crypto = require('node:crypto');

const OTP_TTL_MS = 5 * 60 * 1000;
const RESEND_COOLDOWN_MS = 60 * 1000;
const MAX_ATTEMPTS = 5;
const RECOVERY_CODE_COUNT = 10;
const RECOVERY_CODE_LENGTH = 10;

function nowIso(now = Date.now) {
  return new Date(now()).toISOString();
}

function normalizePhoneE164(phone) {
  if (typeof phone !== 'string') return null;
  const compact = phone.trim().replace(/[\s()-]/g, '');
  if (!compact.startsWith('+')) return null;
  if (!/^\+[1-9]\d{7,14}$/.test(compact)) return null;
  return compact;
}

function maskPhone(phone) {
  if (typeof phone !== 'string' || phone.length < 6) return '***';
  return `${phone.slice(0, 4)}***${phone.slice(-2)}`;
}

function hmacHex(key, value) {
  return crypto.createHmac('sha256', key).update(value).digest('hex');
}

function secureHexEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const aa = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  if (aa.length !== bb.length || aa.length === 0) return false;
  return crypto.timingSafeEqual(aa, bb);
}

function randomCode(alphabet, length) {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += alphabet[crypto.randomInt(0, alphabet.length)];
  }
  return out;
}

function initSmsOtpSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sms_otp_challenges (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      purpose TEXT NOT NULL,
      phone_e164 TEXT NOT NULL,
      otp_hash TEXT NOT NULL,
      challenge_token_hash TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      resend_available_at TEXT NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 5,
      used_at TEXT,
      created_at TEXT NOT NULL,
      last_sent_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sms_otp_challenges_user ON sms_otp_challenges(user_id, purpose, created_at);
    CREATE INDEX IF NOT EXISTS idx_sms_otp_challenges_expiry ON sms_otp_challenges(expires_at, used_at);

    CREATE TABLE IF NOT EXISTS sms_otp_recovery_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      batch_id TEXT NOT NULL,
      code_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      consumed_at TEXT,
      revoked_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sms_otp_recovery_user ON sms_otp_recovery_codes(user_id, consumed_at, revoked_at);

    CREATE TABLE IF NOT EXISTS auth_throttle_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope TEXT NOT NULL,
      user_id INTEGER,
      ip_address TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_auth_throttle_scope_user_time ON auth_throttle_events(scope, user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_auth_throttle_scope_ip_time ON auth_throttle_events(scope, ip_address, created_at);
  `);
}

function createSmsOtpService({ db, env = process.env, smsSender, now = Date.now, loginPhoneResolver = null, accountGuard = null, onLoginVerified = null }) {
  const hashKey = env.OTP_HASH_KEY || env.JWT_SECRET || env.ENCRYPTION_KEY;
  if (!hashKey) throw new Error('OTP hash key is not configured');
  if (!smsSender || typeof smsSender.sendOtp !== 'function') throw new Error('SMS sender is required');

  const purgeOld = db.prepare('DELETE FROM auth_throttle_events WHERE created_at < ?');
  const userCount = db.prepare('SELECT COUNT(*) AS n FROM auth_throttle_events WHERE scope=? AND user_id=? AND created_at>=?');
  const ipCount = db.prepare('SELECT COUNT(*) AS n FROM auth_throttle_events WHERE scope=? AND ip_address=? AND created_at>=?');
  const insertThrottle = db.prepare('INSERT INTO auth_throttle_events(scope,user_id,ip_address,created_at) VALUES(?,?,?,?)');

  const revokeUnusedChallenges = db.prepare('UPDATE sms_otp_challenges SET used_at=? WHERE user_id=? AND purpose=? AND used_at IS NULL');
  const insertChallenge = db.prepare(`INSERT INTO sms_otp_challenges
    (id,user_id,purpose,phone_e164,otp_hash,challenge_token_hash,expires_at,resend_available_at,attempt_count,max_attempts,created_at,last_sent_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  const getChallenge = db.prepare('SELECT * FROM sms_otp_challenges WHERE id=?');
  const updateChallengeForResend = db.prepare(`UPDATE sms_otp_challenges
    SET otp_hash=?, expires_at=?, resend_available_at=?, last_sent_at=?
    WHERE id=?`);
  const markChallengeUsed = db.prepare('UPDATE sms_otp_challenges SET used_at=? WHERE id=? AND used_at IS NULL');
  const incChallengeAttempt = db.prepare('UPDATE sms_otp_challenges SET attempt_count = attempt_count + 1 WHERE id=?');

  const upsertUser2fa = db.prepare('UPDATE users SET sms_2fa_phone_e164=?, sms_2fa_enabled=1, sms_2fa_enrolled_at=? WHERE id=?');
  const clearUser2fa = db.prepare('UPDATE users SET sms_2fa_phone_e164=NULL, sms_2fa_enabled=0, sms_2fa_enrolled_at=NULL WHERE id=?');
  const getUser2fa = db.prepare('SELECT * FROM users WHERE id=?');

  const revokeRecoveryCodes = db.prepare('UPDATE sms_otp_recovery_codes SET revoked_at=? WHERE user_id=? AND consumed_at IS NULL AND revoked_at IS NULL');
  const insertRecoveryCode = db.prepare('INSERT INTO sms_otp_recovery_codes(user_id,batch_id,code_hash,created_at) VALUES(?,?,?,?)');
  const getActiveRecovery = db.prepare('SELECT id, code_hash FROM sms_otp_recovery_codes WHERE user_id=? AND consumed_at IS NULL AND revoked_at IS NULL');
  const consumeRecoveryById = db.prepare('UPDATE sms_otp_recovery_codes SET consumed_at=? WHERE id=? AND consumed_at IS NULL AND revoked_at IS NULL');
  const countRecovery = db.prepare('SELECT COUNT(*) AS n FROM sms_otp_recovery_codes WHERE user_id=? AND consumed_at IS NULL AND revoked_at IS NULL');

  function checkAccount(userId, details = {}) {
    const user = getUser2fa.get(userId);
    if (!user) return { ok: false, reason: 'not_found' };
    if (user.account_status === 'blocked') return { ok: false, reason: 'account_blocked' };
    return accountGuard ? accountGuard(user, details) : { ok: true };
  }

  function hashOtp(challengeId, otp) {
    return hmacHex(hashKey, `otp:${challengeId}:${otp}`);
  }

  function hashChallengeToken(challengeId, token) {
    return hmacHex(hashKey, `challenge:${challengeId}:${token}`);
  }

  function hashRecoveryCode(userId, code) {
    return hmacHex(hashKey, `recovery:${userId}:${String(code || '').trim().toUpperCase()}`);
  }

  function throttle(scope, { userId = null, ipAddress = null, windowMs = 15 * 60 * 1000, maxUser = 8, maxIp = 30 } = {}) {
    const nowAt = nowIso(now);
    const threshold = new Date(now() - windowMs).toISOString();
    purgeOld.run(threshold);
    if (userId != null) {
      const { n } = userCount.get(scope, userId, threshold);
      if (n >= maxUser) return { blocked: true, reason: 'user_throttled' };
    }
    if (ipAddress) {
      const { n } = ipCount.get(scope, ipAddress, threshold);
      if (n >= maxIp) return { blocked: true, reason: 'ip_throttled' };
    }
    insertThrottle.run(scope, userId, ipAddress, nowAt);
    return { blocked: false };
  }

  async function sendChallengeSms({ phone, otp, purpose }) {
    const msg = purpose === 'enrollment'
      ? `Wolf's Legacy verification code: ${otp}. Expires in 5 minutes.`
      : `Wolf's Legacy login code: ${otp}. Expires in 5 minutes.`;
    await smsSender.sendOtp({ to: phone, message: msg });
  }

  async function createChallenge({ userId, purpose, phone }) {
    const access = checkAccount(userId, { purpose, phone });
    if (!access.ok) throw new Error(access.reason);
    const id = crypto.randomUUID();
    const challengeToken = crypto.randomBytes(24).toString('hex');
    const otp = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    const createdAt = nowIso(now);
    const expiresAt = new Date(now() + OTP_TTL_MS).toISOString();
    const resendAt = new Date(now() + RESEND_COOLDOWN_MS).toISOString();

    db.transaction(() => {
      revokeUnusedChallenges.run(createdAt, userId, purpose);
      insertChallenge.run(
        id,
        userId,
        purpose,
        phone,
        hashOtp(id, otp),
        hashChallengeToken(id, challengeToken),
        expiresAt,
        resendAt,
        0,
        MAX_ATTEMPTS,
        createdAt,
        createdAt
      );
    }).immediate();

    try {
      await sendChallengeSms({ phone, otp, purpose });
      if (!checkAccount(userId, { purpose, phone }).ok) throw new Error('Account access changed');
    } catch (err) {
      db.prepare('DELETE FROM sms_otp_challenges WHERE id=?').run(id);
      throw err;
    }

    return {
      challenge_id: id,
      challenge_token: challengeToken,
      expires_at: expiresAt,
      resend_available_at: resendAt,
      masked_phone: maskPhone(phone)
    };
  }

  function readChallengeForVerify({ challengeId, challengeToken, purpose, userId = null }) {
    const c = getChallenge.get(challengeId);
    if (!c || c.purpose !== purpose) return { ok: false, reason: 'not_found' };
    if (userId != null && c.user_id !== userId) return { ok: false, reason: 'forbidden' };
    if (!secureHexEqual(c.challenge_token_hash, hashChallengeToken(c.id, challengeToken || ''))) {
      return { ok: false, reason: 'forbidden' };
    }
    const access = checkAccount(c.user_id, { purpose, phone: c.phone_e164 });
    if (!access.ok) return access;
    if (c.used_at) return { ok: false, reason: 'already_used' };
    if (new Date(c.expires_at).getTime() < now()) return { ok: false, reason: 'expired' };
    if (c.attempt_count >= c.max_attempts) return { ok: false, reason: 'locked' };
    return { ok: true, challenge: c };
  }

  function verifyOtpAttempt(challenge, otp) {
    const candidate = String(otp || '').trim();
    if (!/^\d{6}$/.test(candidate)) return { ok: false, reason: 'invalid_otp' };
    const expected = hashOtp(challenge.id, candidate);
    if (!secureHexEqual(challenge.otp_hash, expected)) {
      incChallengeAttempt.run(challenge.id);
      const row = getChallenge.get(challenge.id);
      if (row.attempt_count >= row.max_attempts) return { ok: false, reason: 'locked' };
      return { ok: false, reason: 'invalid_otp' };
    }
    return { ok: true };
  }

  function consumeRecoveryCode(userId, code) {
    return db.transaction(() => {
      if (!checkAccount(userId, { purpose: 'recovery' }).ok) return false;
      const hash = hashRecoveryCode(userId, code);
      const rows = getActiveRecovery.all(userId);
      for (const row of rows) {
        if (secureHexEqual(row.code_hash, hash)) {
          const at = nowIso(now);
          return consumeRecoveryById.run(at, row.id).changes === 1;
        }
      }
      return false;
    }).immediate();
  }

  function generateRecoveryCodes(userId) {
    const at = nowIso(now);
    const batchId = crypto.randomUUID();
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    revokeRecoveryCodes.run(at, userId);
    const plain = [];
    for (let i = 0; i < RECOVERY_CODE_COUNT; i += 1) {
      const code = randomCode(alphabet, RECOVERY_CODE_LENGTH);
      plain.push(code);
      insertRecoveryCode.run(userId, batchId, hashRecoveryCode(userId, code), at);
    }
    return plain;
  }

  async function startEnrollment({ userId, phone }) {
    const normalized = normalizePhoneE164(phone);
    if (!normalized) return { ok: false, reason: 'invalid_phone' };
    const access = checkAccount(userId, { purpose: 'enrollment', phone: normalized });
    if (!access.ok) return access;
    try {
      const challenge = await createChallenge({ userId, purpose: 'enrollment', phone: normalized });
      return { ok: true, challenge };
    } catch {
      return { ok: false, reason: 'sms_unavailable' };
    }
  }

  function completeEnrollment({ userId, challengeId, challengeToken, otp }) {
    return db.transaction(() => {
      const found = readChallengeForVerify({ challengeId, challengeToken, purpose: 'enrollment', userId });
      if (!found.ok) return found;
      const otpResult = verifyOtpAttempt(found.challenge, otp);
      if (!otpResult.ok) return otpResult;
      const at = nowIso(now);
      markChallengeUsed.run(at, found.challenge.id);
      upsertUser2fa.run(found.challenge.phone_e164, at, userId);
      return { ok: true, recovery_codes: generateRecoveryCodes(userId), phone: found.challenge.phone_e164 };
    }).immediate();
  }

  async function issueLoginChallenge({ userId, phone }) {
    const access = checkAccount(userId, { purpose: 'login', phone });
    if (!access.ok) return access;
    try {
      const challenge = await createChallenge({ userId, purpose: 'login', phone });
      return { ok: true, challenge };
    } catch {
      return { ok: false, reason: 'sms_unavailable' };
    }
  }

  function verifyLoginChallenge({ challengeId, challengeToken, otp, recoveryCode }) {
    return db.transaction(() => {
      const found = readChallengeForVerify({ challengeId, challengeToken, purpose: 'login' });
      if (!found.ok) return found;
      const user = getUser2fa.get(found.challenge.user_id);
      if (!user) return { ok: false, reason: 'not_found' };
      const currentPhone = loginPhoneResolver ? loginPhoneResolver(user) : normalizePhoneE164(user.sms_2fa_phone_e164);
      if ((env.AUTH_SMS_REQUIRED === 'true' || user.sms_2fa_enabled || user.account_status === 'registered_unverified') && currentPhone !== found.challenge.phone_e164) {
        return { ok: false, reason: 'phone_changed' };
      }

      const at = nowIso(now);
      if (typeof recoveryCode === 'string' && recoveryCode.trim()) {
        // Recovery codes can recover an enrolled account, but never establish
        // ownership of a new or replacement mobile number.
        const consumed = !!user.sms_2fa_enabled && consumeRecoveryCode(found.challenge.user_id, recoveryCode);
        if (!consumed) {
          incChallengeAttempt.run(found.challenge.id);
          const row = getChallenge.get(found.challenge.id);
          if (row.attempt_count >= row.max_attempts) return { ok: false, reason: 'locked' };
          return { ok: false, reason: 'invalid_recovery_code' };
        }
        markChallengeUsed.run(at, found.challenge.id);
        return { ok: true, user_id: found.challenge.user_id, method: 'recovery_code' };
      }

      const otpResult = verifyOtpAttempt(found.challenge, otp);
      if (!otpResult.ok) return otpResult;
      markChallengeUsed.run(at, found.challenge.id);
      const result = { ok: true, user_id: found.challenge.user_id, method: 'sms_otp' };
      if ((env.AUTH_SMS_REQUIRED === 'true' || user.account_status === 'registered_unverified') && !user.sms_2fa_enabled) {
        upsertUser2fa.run(found.challenge.phone_e164, at, user.id);
        result.recovery_codes = generateRecoveryCodes(user.id);
        result.phone = found.challenge.phone_e164;
      }
      if (onLoginVerified) onLoginVerified({ user, phone: found.challenge.phone_e164 });
      return result;
    }).immediate();
  }

  async function resendChallenge({ challengeId, challengeToken, purpose, userId = null }) {
    const found = readChallengeForVerify({ challengeId, challengeToken, purpose, userId });
    if (!found.ok) return found;
    if (new Date(found.challenge.resend_available_at).getTime() > now()) {
      return { ok: false, reason: 'cooldown', resend_available_at: found.challenge.resend_available_at };
    }
    const otp = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    const expiresAt = new Date(now() + OTP_TTL_MS).toISOString();
    const resendAt = new Date(now() + RESEND_COOLDOWN_MS).toISOString();
    const at = nowIso(now);
    updateChallengeForResend.run(hashOtp(found.challenge.id, otp), expiresAt, resendAt, at, found.challenge.id);
    try {
      await sendChallengeSms({ phone: found.challenge.phone_e164, otp, purpose });
      const access = checkAccount(found.challenge.user_id, { purpose, phone: found.challenge.phone_e164 });
      if (!access.ok) return access;
    } catch {
      return { ok: false, reason: 'sms_unavailable' };
    }
    return {
      ok: true,
      expires_at: expiresAt,
      resend_available_at: resendAt,
      masked_phone: maskPhone(found.challenge.phone_e164)
    };
  }

  function status(userId) {
    const row = getUser2fa.get(userId);
    if (!row) return null;
    return {
      enabled: !!row.sms_2fa_enabled,
      required: env.AUTH_SMS_REQUIRED === 'true',
      masked_phone: row.sms_2fa_phone_e164 ? maskPhone(row.sms_2fa_phone_e164) : null,
      enrolled_at: row.sms_2fa_enrolled_at,
      recovery_codes_remaining: countRecovery.get(userId).n
    };
  }

  function regenerateRecoveryCodes(userId) {
    return db.transaction(() => {
      if (!checkAccount(userId, { purpose: 'recovery' }).ok) throw new Error('Account access is blocked');
      return generateRecoveryCodes(userId);
    })();
  }

  function disable2fa(userId) {
    const at = nowIso(now);
    return db.transaction(() => {
      if (!checkAccount(userId, { purpose: 'disable' }).ok) throw new Error('Account access is blocked');
      clearUser2fa.run(userId);
      revokeRecoveryCodes.run(at, userId);
      revokeUnusedChallenges.run(at, userId, 'enrollment');
      revokeUnusedChallenges.run(at, userId, 'login');
    })();
  }

  return {
    throttle,
    startEnrollment,
    completeEnrollment,
    issueLoginChallenge,
    verifyLoginChallenge,
    resendChallenge,
    status,
    regenerateRecoveryCodes,
    consumeRecoveryCode,
    disable2fa,
    normalizePhoneE164,
    maskPhone
  };
}

module.exports = {
  OTP_TTL_MS,
  RESEND_COOLDOWN_MS,
  MAX_ATTEMPTS,
  initSmsOtpSchema,
  createSmsOtpService,
  normalizePhoneE164,
  maskPhone
};
