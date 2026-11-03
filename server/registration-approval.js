'use strict';

const crypto = require('node:crypto');
const { decrypt } = require('./crypto');
const { normalizeAuthPhone, resolveSavedPhone } = require('./sms-auth-policy');
const { validateEmail, validateString } = require('./validate');
const { isVerifiedGatewayActor } = require('./local-auth-gateway');
const { initFamilyRegistrationSchema, createFamilyRegistrationService } = require('./family-registration');

const INVITATION_TTL_MS = 48 * 60 * 60 * 1000;
const REQUEST_MESSAGE = 'Request submitted. Account creation requires owner approval.';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function initRegistrationApprovalSchema(db) {
  return db.transaction(() => migrateRegistrationApprovalSchema(db)).immediate();
}

function migrateRegistrationApprovalSchema(db) {
  const columns = db.prepare('PRAGMA table_info(users)').all().map(column => column.name);
  if (!columns.includes('account_status')) {
    db.exec("ALTER TABLE users ADD COLUMN account_status TEXT NOT NULL DEFAULT 'active' CHECK(account_status IN ('active','registered_unverified','blocked'))");
  }
  if (!columns.includes('auth_version')) db.exec('ALTER TABLE users ADD COLUMN auth_version INTEGER NOT NULL DEFAULT 0');
  db.exec(`
    CREATE TABLE IF NOT EXISTS registration_requests (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      phone_e164 TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','registered')),
      status_secret_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      decided_at TEXT,
      decided_by_user_id INTEGER REFERENCES users(id),
      decision_reason TEXT,
      notification_status TEXT NOT NULL DEFAULT 'pending' CHECK(notification_status IN ('pending','sending','submitted','failed')),
      notification_attempts INTEGER NOT NULL DEFAULT 0,
      notification_attempted_at TEXT,
      notification_submitted_at TEXT,
      invitation_token_hash TEXT,
      invitation_expires_at TEXT,
      invitation_used_at TEXT,
      registered_user_id INTEGER UNIQUE REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_registration_requests_status ON registration_requests(status, created_at);
    CREATE TABLE IF NOT EXISTS registration_denials (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL,
      phone_e164 TEXT NOT NULL,
      request_id TEXT NOT NULL REFERENCES registration_requests(id),
      created_by_user_id INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL,
      lifted_at TEXT,
      lifted_by_user_id INTEGER REFERENCES users(id),
      lift_reason TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_registration_denials_email ON registration_denials(email, lifted_at);
    CREATE INDEX IF NOT EXISTS idx_registration_denials_phone ON registration_denials(phone_e164, lifted_at);
    CREATE TABLE IF NOT EXISTS registration_throttle_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ip_hash TEXT NOT NULL,
      contact_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_registration_throttle_ip ON registration_throttle_events(ip_hash, created_at);
    CREATE INDEX IF NOT EXISTS idx_registration_throttle_contact ON registration_throttle_events(contact_hash, created_at);
    CREATE INDEX IF NOT EXISTS idx_registration_throttle_time ON registration_throttle_events(created_at);
  `);
  const requestColumns = db.prepare('PRAGMA table_info(registration_requests)').all().map(column => column.name);
  for (const [column, definition] of Object.entries({
    family_sponsor_user_id: 'INTEGER REFERENCES users(id)',
    family_beneficiary_id: 'INTEGER',
    eligibility_invalidated_at: 'TEXT'
  })) {
    if (!requestColumns.includes(column)) db.exec(`ALTER TABLE registration_requests ADD COLUMN ${column} ${definition}`);
  }
  db.exec(`
    UPDATE registration_requests SET eligibility_invalidated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE status IN ('pending','approved') AND eligibility_invalidated_at IS NULL
      AND (family_sponsor_user_id IS NULL OR family_beneficiary_id IS NULL);
    DROP INDEX IF EXISTS idx_registration_open_email;
    DROP INDEX IF EXISTS idx_registration_open_phone;
    CREATE UNIQUE INDEX idx_registration_open_email ON registration_requests(email)
      WHERE status IN ('pending','approved') AND eligibility_invalidated_at IS NULL;
    CREATE UNIQUE INDEX idx_registration_open_phone ON registration_requests(phone_e164)
      WHERE status IN ('pending','approved') AND eligibility_invalidated_at IS NULL;
    CREATE TRIGGER IF NOT EXISTS registration_family_binding_immutable
      BEFORE UPDATE OF family_sponsor_user_id,family_beneficiary_id,email,phone_e164 ON registration_requests
      WHEN NEW.family_sponsor_user_id IS NOT OLD.family_sponsor_user_id
        OR NEW.family_beneficiary_id IS NOT OLD.family_beneficiary_id
        OR NEW.email IS NOT OLD.email OR NEW.phone_e164 IS NOT OLD.phone_e164
      BEGIN SELECT RAISE(ABORT,'Registration family identity is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS registration_invalidation_permanent
      BEFORE UPDATE OF eligibility_invalidated_at ON registration_requests
      WHEN OLD.eligibility_invalidated_at IS NOT NULL AND NEW.eligibility_invalidated_at IS NOT OLD.eligibility_invalidated_at
      BEGIN SELECT RAISE(ABORT,'Registration invalidation is permanent'); END;
  `);
  initFamilyRegistrationSchema(db);
}

function normalizeEmail(value) { return typeof value === 'string' ? value.trim().toLowerCase() : ''; }
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !/^[a-f0-9]{64}$/.test(a) || !/^[a-f0-9]{64}$/.test(b)) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}
function createRegistrationApprovalService({ db, env = process.env, now = Date.now, smsSender, decryptFields = decrypt, auditWriter } = {}) {
  const hashKey = env.ACCOUNT_APPROVAL_HASH_KEY || env.OTP_HASH_KEY || env.JWT_SECRET;
  const keyReady = typeof hashKey === 'string' && hashKey !== 'auto' && hashKey.length >= 32;
  const timestamp = () => new Date(now()).toISOString();
  const hash = (purpose, value) => crypto.createHmac('sha256', hashKey || 'unconfigured').update(`${purpose}:${value}`).digest('hex');
  const family = createFamilyRegistrationService({ db, env, now });
  function familyEligibility(request) {
    if (request.eligibility_invalidated_at) return { ok: false, reason: 'family_eligibility_required' };
    const result = family.validateBinding(request);
    // Configuration outages must not permanently invalidate a family's requests.
    if (!result.ok && result.reason !== 'family_unavailable' && ['pending', 'approved'].includes(request.status)) {
      db.prepare('UPDATE registration_requests SET eligibility_invalidated_at=COALESCE(eligibility_invalidated_at,?) WHERE id=?').run(timestamp(), request.id);
    }
    return result;
  }
  function audit(actor, action, requestId, detail = null, ip = null) {
    // No status secret, invitation, full contact, provider response or password belongs in audit logs.
    if (auditWriter) return auditWriter(actor, action, 'registration_request', null, JSON.stringify({ request_id: requestId, ...detail }), ip);
    db.prepare('INSERT INTO audit_log(user_id,action,target_type,target_id,detail,ip_address) VALUES(?,?,?,?,?,?)')
      .run(actor, action, 'registration_request', null, JSON.stringify({ request_id: requestId, ...detail }), ip);
  }
  function ownerConfiguration({ requireTransport = false } = {}) {
    const id = Number(env.ACCOUNT_APPROVAL_OWNER_USER_ID);
    const phone = normalizeAuthPhone(env.ACCOUNT_APPROVAL_OWNER_SMS_E164, env);
    if (!keyReady || !Number.isSafeInteger(id) || id <= 0 || !phone) return { ok: false, reason: 'approval_unavailable' };
    const owner = db.prepare('SELECT * FROM users WHERE id=?').get(id);
    if (!owner || owner.account_status !== 'active' || !owner.sms_2fa_enabled || normalizeAuthPhone(owner.sms_2fa_phone_e164, env) !== phone) {
      return { ok: false, reason: 'approval_unavailable' };
    }
    let base;
    try {
      base = new URL(env.APP_BASE_URL);
      if (base.username || base.password || base.search || base.hash || base.pathname !== '/' ||
          (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)))) throw new Error('invalid base');
    } catch { return { ok: false, reason: 'approval_unavailable' }; }
    if (requireTransport && (!smsSender?.configured || typeof smsSender.sendOtp !== 'function')) return { ok: false, reason: 'approval_unavailable' };
    return { ok: true, owner, phone, baseUrl: base.origin };
  }
  function isOwner(user) {
    const config = ownerConfiguration();
    return !!(config.ok && user && Number(user.id) === config.owner.id && (user.mfa === 'sms_otp' || isVerifiedGatewayActor(user, env)) &&
      Number(user.auth_version || 0) === Number(config.owner.auth_version || 0));
  }
  function hasDenial(email, phone) {
    return !!db.prepare('SELECT 1 FROM registration_denials WHERE lifted_at IS NULL AND (email=? OR phone_e164=?) LIMIT 1').get(normalizeEmail(email), normalizeAuthPhone(phone, env) || '');
  }
  function existingIdentity(email, phone, excludeUserId = null) {
    const normalizedEmail = normalizeEmail(email), normalizedPhone = normalizeAuthPhone(phone, env);
    const users = db.prepare('SELECT * FROM users WHERE id != ?').all(excludeUserId || -1);
    for (const user of users) {
      if (normalizeEmail(user.email) === normalizedEmail || (normalizedPhone && normalizeAuthPhone(user.sms_2fa_phone_e164, env) === normalizedPhone)) return true;
      // Protect legacy profile numbers too, even if profiles are ambiguous and
      // cannot yet supply the one phone for normal authentication.
      if (normalizedPhone && db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='vault_entries'").get()) {
        const resolved = resolveSavedPhone(db, user, env, decryptFields);
        if (resolved.phone === normalizedPhone) return true;
        if (decryptFields) {
          for (const row of db.prepare("SELECT fields_encrypted FROM vault_entries WHERE user_id=? AND section='personal'").all(user.id)) {
            try { if (normalizeAuthPhone(JSON.parse(decryptFields(row.fields_encrypted))?.mobile_phone, env) === normalizedPhone) return true; }
            catch { /* Unreadable profile supplies no asserted identity. */ }
          }
        }
      }
    }
    return false;
  }
  function accountAccess(user, { phone = null } = {}) {
    if (!user || user.account_status === 'blocked') return { ok: false, reason: 'account_blocked' };
    const request = db.prepare('SELECT * FROM registration_requests WHERE registered_user_id=?').get(user.id);
    // Migrated accounts retain their own verified identity. A visitor's contact
    // assertion must never revoke these accounts.
    if (!request) return user.account_status === 'registered_unverified' ? { ok: false, reason: 'approval_required' } : { ok: true };
    if (request.status !== 'registered' || !request.invitation_used_at) return { ok: false, reason: 'approval_required' };
    if (user.account_status === 'registered_unverified' && (normalizeEmail(user.email) !== request.email ||
        normalizeAuthPhone(user.sms_2fa_phone_e164, env) !== request.phone_e164 || hasDenial(request.email, request.phone_e164))) {
      return { ok: false, reason: 'approval_required' };
    }
    if (user.account_status === 'registered_unverified' && phone && normalizeAuthPhone(phone, env) !== request.phone_e164) return { ok: false, reason: 'phone_changed' };
    return { ok: true, approved_phone: request.phone_e164, registration_request_id: request.id };
  }
  function genericRequestResult() {
    return { ok: true, message: REQUEST_MESSAGE, request_id: crypto.randomUUID(), status_secret: crypto.randomBytes(32).toString('hex') };
  }
  function throttle(ip, email, phone) {
    const at = timestamp(), cutoff = new Date(now() - 60 * 60 * 1000).toISOString();
    const recent = new Date(now() - 15 * 60 * 1000).toISOString();
    const ipHash = hash('ip', String(ip || 'unknown')), contactHash = hash('contact', `${email}:${phone}`);
    db.prepare('DELETE FROM registration_throttle_events WHERE created_at < ?').run(cutoff);
    const ipCount = db.prepare('SELECT COUNT(*) n FROM registration_throttle_events WHERE ip_hash=? AND created_at>=?').get(ipHash, recent).n;
    const contactCount = db.prepare('SELECT COUNT(*) n FROM registration_throttle_events WHERE contact_hash=? AND created_at>=?').get(contactHash, cutoff).n;
    const total = db.prepare('SELECT COUNT(*) n FROM registration_throttle_events WHERE created_at>=?').get(cutoff).n;
    if (ipCount >= 5 || contactCount >= 3 || total >= 30) return false;
    db.prepare('INSERT INTO registration_throttle_events(ip_hash,contact_hash,created_at) VALUES(?,?,?)').run(ipHash, contactHash, at);
    return true;
  }
  async function notifyOwner(requestId, { retry = false, actorId = null, ipAddress = null } = {}) {
    const config = ownerConfiguration({ requireTransport: true });
    if (!config.ok) return config;
    const claim = db.transaction(() => {
      const request = db.prepare('SELECT * FROM registration_requests WHERE id=?').get(requestId);
      if (!request || request.status !== 'pending') return { ok: false, reason: 'not_pending' };
      const eligible = familyEligibility(request);
      if (!eligible.ok) return eligible;
      if (request.notification_attempts >= 3 || request.notification_status === 'submitted' ||
          (request.notification_attempts && (!retry || now() - Date.parse(request.notification_attempted_at) < 5 * 60 * 1000))) return { ok: false, reason: 'notification_limited' };
      db.prepare("UPDATE registration_requests SET notification_status='sending',notification_attempts=notification_attempts+1,notification_attempted_at=? WHERE id=?").run(timestamp(), request.id);
      return { ok: true, request };
    }).immediate();
    if (!claim.ok) return claim;
    const request = claim.request;
    const safeName = request.name.replace(/[\r\n\t]/g, ' ').slice(0, 80);
    const [local, domain] = request.email.split('@');
    const maskedEmail = `${local.slice(0, 1)}***@${domain}`;
    const maskedPhone = `${request.phone_e164.slice(0, 3)}******${request.phone_e164.slice(-3)}`;
    try {
      await smsSender.sendOtp({ to: config.phone, message: `Wolf's Legacy: Account request ${request.id} from ${safeName} (${maskedEmail}, ${maskedPhone}). Approve or Reject after signing in: ${config.baseUrl}/#admin/registration-requests/${request.id}` });
    } catch {
      db.prepare("UPDATE registration_requests SET notification_status='failed',updated_at=? WHERE id=?").run(timestamp(), request.id);
      audit(actorId, 'approval_sms_failed', request.id, null, ipAddress);
      return { ok: false, reason: 'notification_failed' };
    }
    db.prepare("UPDATE registration_requests SET notification_status='submitted',notification_submitted_at=?,updated_at=? WHERE id=?").run(timestamp(), timestamp(), request.id);
    audit(actorId, 'approval_sms_submitted', request.id, null, ipAddress);
    return { ok: true };
  }
  async function requestAccess({ name, email, phone, ipAddress = null }) {
    const cleanEmail = normalizeEmail(email), cleanPhone = normalizeAuthPhone(phone, env);
    if (!validateString(name, 1, 200) || !validateEmail(cleanEmail) || cleanEmail.length > 254 || !cleanPhone) return { ok: false, reason: 'invalid_request' };
    const config = ownerConfiguration({ requireTransport: true });
    if (!config.ok) return config;
    const result = db.transaction(() => {
      const sponsor = family.findSponsor({ email: cleanEmail, phone: cleanPhone });
      if (!sponsor.ok) return sponsor.reason === 'family_unavailable' ? sponsor : genericRequestResult();
      if (!throttle(ipAddress, cleanEmail, cleanPhone)) return { ok: false, reason: 'rate_limited' };
      for (const prior of db.prepare("SELECT * FROM registration_requests WHERE (email=? OR phone_e164=?) AND status IN ('pending','approved') AND eligibility_invalidated_at IS NULL").all(cleanEmail, cleanPhone)) {
        const eligible = familyEligibility(prior);
        if (!eligible.ok && eligible.reason === 'family_unavailable') return eligible;
      }
      if (existingIdentity(cleanEmail, cleanPhone) || hasDenial(cleanEmail, cleanPhone) ||
          db.prepare("SELECT 1 FROM registration_requests WHERE (email=? OR phone_e164=?) AND (status='registered' OR (status IN ('pending','approved') AND eligibility_invalidated_at IS NULL))").get(cleanEmail, cleanPhone)) return genericRequestResult();
      const response = genericRequestResult(), at = timestamp();
      db.prepare('INSERT INTO registration_requests(id,name,email,phone_e164,status_secret_hash,created_at,updated_at,family_sponsor_user_id,family_beneficiary_id) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(response.request_id, name.trim(), cleanEmail, cleanPhone, hash('status', `${response.request_id}:${response.status_secret}`), at, at, sponsor.sponsorUserId, sponsor.beneficiaryId);
      audit(null, 'registration_requested', response.request_id, null, ipAddress);
      return { ...response, notify: true };
    }).immediate();
    if (result.notify) await notifyOwner(result.request_id, { ipAddress });
    delete result.notify;
    return result;
  }
  function invitationToken(request) { return `${request.id}.${hash('invitation', `${request.id}:${request.status_secret_hash}:${request.decided_at}`)}`; }
  function invitationView(request) {
    const token = invitationToken(request), config = ownerConfiguration();
    return { request_id: request.id, name: request.name, email: request.email, phone: request.phone_e164, expires_at: request.invitation_expires_at,
      invitation_token: token, invitation_url: `${config.baseUrl}/#register/invite/${token}` };
  }
  function parseInvitation(token) {
    if (typeof token !== 'string' || token.length > 120) return null;
    const parts = token.split('.');
    return parts.length === 2 && UUID_RE.test(parts[0]) && /^[a-f0-9]{64}$/.test(parts[1]) ? parts[0] : null;
  }
  function validateInvitation({ invitationToken: token, requestId, email, phone, excludeUserId = null } = {}) {
    if (!ownerConfiguration().ok) return { ok: false, reason: 'approval_unavailable' };
    const id = parseInvitation(token);
    if (!id || (requestId && requestId !== id)) return { ok: false, reason: 'invitation_invalid' };
    const request = db.prepare('SELECT * FROM registration_requests WHERE id=?').get(id);
    if (!request || !safeEqual(request.invitation_token_hash, hash('invitation-token', token))) return { ok: false, reason: 'invitation_invalid' };
    if (request.invitation_used_at || request.status === 'registered') return { ok: false, reason: 'invitation_used' };
    if (request.status !== 'approved') return { ok: false, reason: 'approval_required' };
    const eligible = familyEligibility(request);
    if (!eligible.ok) return eligible;
    if (Date.parse(request.invitation_expires_at) <= now()) return { ok: false, reason: 'invitation_expired' };
    if ((email !== undefined && normalizeEmail(email) !== request.email) || (phone !== undefined && normalizeAuthPhone(phone, env) !== request.phone_e164)) return { ok: false, reason: 'invitation_identity_mismatch' };
    if (hasDenial(request.email, request.phone_e164) || existingIdentity(request.email, request.phone_e164, excludeUserId)) return { ok: false, reason: 'approval_required' };
    return { ok: true, request };
  }
  function consumeInvitation({ invitationToken, requestId, email, phone, userId } = {}) {
    if (!db.inTransaction) throw new Error('Invitation consumption requires an account-creation transaction');
    const result = validateInvitation({ invitationToken, requestId, email, phone, excludeUserId: userId });
    if (!result.ok) return result;
    const user = db.prepare('SELECT * FROM users WHERE id=?').get(userId);
    const request = result.request;
    if (!user || normalizeEmail(user.email) !== request.email || normalizeAuthPhone(user.sms_2fa_phone_e164, env) !== request.phone_e164 || user.account_status !== 'registered_unverified') return { ok: false, reason: 'invitation_identity_mismatch' };
    const at = timestamp();
    const changed = db.prepare("UPDATE registration_requests SET status='registered',registered_user_id=?,invitation_used_at=?,updated_at=? WHERE id=? AND status='approved' AND invitation_used_at IS NULL AND invitation_expires_at>?")
      .run(userId, at, at, request.id, at);
    if (changed.changes !== 1) return { ok: false, reason: 'invitation_used' };
    const member = family.enroll(request, userId);
    if (!member.ok) throw new Error('Family membership could not be recorded');
    audit(userId, 'registration_completed', request.id, { user_id: userId });
    return { ok: true, request };
  }
  function requestStatus({ requestId, statusSecret }) {
    if (!keyReady || !UUID_RE.test(String(requestId)) || typeof statusSecret !== 'string' || !/^[a-f0-9]{64}$/.test(statusSecret)) return { ok: false, reason: 'not_found' };
    const request = db.prepare('SELECT * FROM registration_requests WHERE id=?').get(requestId);
    // Decoys remain pending, and never reveal another applicant's state.
    if (!request || !safeEqual(request.status_secret_hash, hash('status', `${requestId}:${statusSecret}`))) return { ok: true, request_id: requestId, status: 'pending' };
    let status = request.status;
    if (['pending', 'approved'].includes(status)) {
      const eligible = familyEligibility(request);
      if (!eligible.ok && eligible.reason === 'family_unavailable') return eligible;
      if (!eligible.ok) status = 'unavailable';
    }
    if (status === 'approved' && Date.parse(request.invitation_expires_at) <= now()) status = 'expired';
    if (status === 'approved' && hasDenial(request.email, request.phone_e164)) status = 'rejected';
    if (status === 'approved' && !validateInvitation({ invitationToken: invitationToken(request) }).ok) status = 'unavailable';
    return { ok: true, request_id: requestId, status, ...(status === 'approved' && ownerConfiguration().ok ? invitationView(request) : {}) };
  }
  function decide({ requestId, actor, decision, reason = null, confirmed, ipAddress = null } = {}) {
    if (!isOwner(actor)) return { ok: false, reason: 'owner_required' };
    if (confirmed !== true || !['approve', 'reject'].includes(decision) || (reason != null && !validateString(reason, 0, 1000))) return { ok: false, reason: 'confirmation_required' };
    return db.transaction(() => {
      const request = db.prepare('SELECT * FROM registration_requests WHERE id=?').get(requestId);
      if (!request || request.status !== 'pending') return { ok: false, reason: 'not_pending' };
      const eligible = familyEligibility(request);
      if (!eligible.ok) return eligible;
      const at = timestamp();
      if (decision === 'approve') {
        if (hasDenial(request.email, request.phone_e164) || existingIdentity(request.email, request.phone_e164)) return { ok: false, reason: 'identity_unavailable' };
        request.decided_at = at;
        request.invitation_expires_at = new Date(now() + INVITATION_TTL_MS).toISOString();
        const token = invitationToken(request);
        db.prepare("UPDATE registration_requests SET status='approved',decided_at=?,decided_by_user_id=?,decision_reason=?,invitation_token_hash=?,invitation_expires_at=?,updated_at=? WHERE id=? AND status='pending'")
          .run(at, actor.id, reason || null, hash('invitation-token', token), request.invitation_expires_at, at, request.id);
        audit(actor.id, 'registration_approved', request.id, null, ipAddress);
        return { ok: true, status: 'approved', ...invitationView(request) };
      }
      db.prepare("UPDATE registration_requests SET status='rejected',decided_at=?,decided_by_user_id=?,decision_reason=?,updated_at=? WHERE id=? AND status='pending'")
        .run(at, actor.id, reason || null, at, request.id);
      db.prepare('INSERT INTO registration_denials(email,phone_e164,request_id,created_by_user_id,created_at) VALUES(?,?,?,?,?)')
        .run(request.email, request.phone_e164, request.id, actor.id, at);
      audit(actor.id, 'registration_rejected', request.id, null, ipAddress);
      return { ok: true, status: 'rejected', request_id: request.id };
    }).immediate();
  }
  function listRequests({ status = null } = {}) {
    const rows = status ? db.prepare('SELECT * FROM registration_requests WHERE status=? ORDER BY created_at DESC LIMIT 200').all(status) : db.prepare('SELECT * FROM registration_requests ORDER BY created_at DESC LIMIT 200').all();
    return rows.map(row => {
      const { status_secret_hash, invitation_token_hash, ...request } = row;
      if (['pending', 'approved'].includes(row.status)) {
        const eligible = familyEligibility(row);
        if (!eligible.ok) request.status = eligible.reason === 'family_unavailable' ? 'temporarily_unavailable' : 'unavailable';
      }
      const validInvite = row.status === 'approved' && validateInvitation({ invitationToken: invitationToken(row) }).ok;
      return { ...request, phone: request.phone_e164, ...(validInvite ? invitationView(row) : {}) };
    });
  }
  function listDenials() { return db.prepare('SELECT * FROM registration_denials ORDER BY created_at DESC LIMIT 200').all(); }
  function liftDenial({ denialId, actor, confirmed, reason = null, ipAddress = null } = {}) {
    if (!isOwner(actor)) return { ok: false, reason: 'owner_required' };
    if (confirmed !== true || (reason != null && !validateString(reason, 0, 1000))) return { ok: false, reason: 'confirmation_required' };
    return db.transaction(() => {
      const denial = db.prepare('SELECT * FROM registration_denials WHERE id=? AND lifted_at IS NULL').get(denialId);
      if (!denial) return { ok: false, reason: 'not_found' };
      db.prepare('UPDATE registration_denials SET lifted_at=?,lifted_by_user_id=?,lift_reason=? WHERE id=? AND lifted_at IS NULL').run(timestamp(), actor.id, reason, denial.id);
      audit(actor.id, 'denial_lifted', denial.request_id, { denial_id: denial.id }, ipAddress);
      return { ok: true };
    }).immediate();
  }
  function blockUser({ userId, actor, confirmed, reason = null, ipAddress = null } = {}) {
    if (!isOwner(actor)) return { ok: false, reason: 'owner_required' };
    if (confirmed !== true || (reason != null && !validateString(reason, 0, 1000))) return { ok: false, reason: 'confirmation_required' };
    if (Number(userId) === Number(actor.id)) return { ok: false, reason: 'owner_protected' };
    return db.transaction(() => {
      const user = db.prepare('SELECT * FROM users WHERE id=?').get(userId);
      if (!user) return { ok: false, reason: 'not_found' };
      if (user.account_status === 'blocked') return { ok: false, reason: 'already_blocked' };
      const at = timestamp();
      db.prepare("UPDATE users SET account_status='blocked',auth_version=auth_version+1 WHERE id=?").run(user.id);
      db.prepare('UPDATE sms_otp_challenges SET used_at=? WHERE user_id=? AND used_at IS NULL').run(at, user.id);
      db.prepare('UPDATE sms_otp_recovery_codes SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL').run(at, user.id);
      db.prepare('UPDATE registration_requests SET invitation_used_at=COALESCE(invitation_used_at,?),updated_at=? WHERE registered_user_id=?').run(at, at, user.id);
      audit(actor.id, 'account_blocked', null, { user_id: user.id }, ipAddress);
      return { ok: true };
    }).immediate();
  }
  return { ownerConfiguration, isOwner, hasDenial, isDenied: hasDenial, existingIdentity, identityConflict: existingIdentity, accountAccess, requestAccess, requestStatus, validateInvitation, consumeInvitation,
    invitationView, decide, listRequests, listDenials, liftDenial, blockUser, notifyOwner };
}

module.exports = { initRegistrationApprovalSchema, createRegistrationApprovalService, INVITATION_TTL_MS };
