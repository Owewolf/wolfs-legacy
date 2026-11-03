'use strict';

const { normalizeAuthPhone } = require('./sms-auth-policy');
const { validateEmail } = require('./validate');
const unavailable = () => ({ ok: false, reason: 'family_unavailable' });
const ineligible = () => ({ ok: false, reason: 'family_eligibility_required' });
const normalizeEmail = value => typeof value === 'string' ? value.trim().toLowerCase() : '';
const validId = value => Number.isSafeInteger(value) && value > 0;

// Identity facts outlive a sponsoring beneficiary record. The historical IDs
// intentionally have no beneficiary/request FK, so deleting a contact cannot
// revoke a completed member's lineage. Accounts and lineage cannot be deleted.
function initFamilyRegistrationSchema(db) {
  db.transaction(() => {
    const expected = {
      family_registration_root: ['id', 'root_user_id', 'created_at'],
      family_memberships: ['user_id', 'root_user_id', 'sponsor_user_id', 'sponsor_beneficiary_id', 'source_registration_request_id', 'created_at']
    };
    for (const [table, columns] of Object.entries(expected)) {
      const actual = db.prepare('PRAGMA table_info(' + table + ')').all().map(column => column.name);
      if (actual.length && columns.some(column => !actual.includes(column))) throw new Error('Incomplete family registration schema');
    }
    db.exec(`CREATE TABLE IF NOT EXISTS family_registration_root (
      id INTEGER PRIMARY KEY CHECK(id=1),
      root_user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE RESTRICT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS family_memberships (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
      root_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      sponsor_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      sponsor_beneficiary_id INTEGER NOT NULL UNIQUE CHECK(sponsor_beneficiary_id>0),
      source_registration_request_id TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      CHECK(user_id<>root_user_id AND user_id<>sponsor_user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_family_memberships_root ON family_memberships(root_user_id);
    CREATE TRIGGER IF NOT EXISTS family_root_no_update BEFORE UPDATE ON family_registration_root
      BEGIN SELECT RAISE(ABORT,'Family root is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS family_root_no_delete BEFORE DELETE ON family_registration_root
      BEGIN SELECT RAISE(ABORT,'Family root is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS family_root_no_replace BEFORE INSERT ON family_registration_root
      WHEN EXISTS(SELECT 1 FROM family_registration_root)
      BEGIN SELECT RAISE(ABORT,'Family root is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS family_membership_no_update BEFORE UPDATE ON family_memberships
      BEGIN SELECT RAISE(ABORT,'Family membership is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS family_membership_no_delete BEFORE DELETE ON family_memberships
      BEGIN SELECT RAISE(ABORT,'Family membership is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS family_membership_validate_insert BEFORE INSERT ON family_memberships
      WHEN NOT EXISTS(SELECT 1 FROM family_registration_root WHERE id=1 AND root_user_id=NEW.root_user_id)
        OR EXISTS(SELECT 1 FROM family_memberships WHERE user_id=NEW.user_id
          OR sponsor_beneficiary_id=NEW.sponsor_beneficiary_id OR source_registration_request_id=NEW.source_registration_request_id)
        OR (NEW.sponsor_user_id<>NEW.root_user_id AND NOT EXISTS(SELECT 1 FROM family_memberships
          WHERE user_id=NEW.sponsor_user_id AND root_user_id=NEW.root_user_id))
      BEGIN SELECT RAISE(ABORT,'Invalid or previously consumed family lineage'); END;`);
  })();
}

function createFamilyRegistrationService({ db, env = process.env, now = Date.now } = {}) {
  function hasColumns(table, required) {
    const columns = db.prepare('PRAGMA table_info(' + table + ')').all().map(column => column.name);
    return required.every(column => columns.includes(column));
  }
  function verifiedAccount(user) {
    return !!(user && user.account_status === 'active' && Number(user.sms_2fa_enabled) === 1 &&
      normalizeAuthPhone(user.sms_2fa_phone_e164, env));
  }
  function configuration() {
    try {
      const configured = env.ACCOUNT_FAMILY_ROOT_USER_ID;
      if (typeof configured !== 'string' || !/^[1-9]\d*$/.test(configured)) return unavailable();
      const rootUserId = Number(configured);
      if (!validId(rootUserId) || !hasColumns('users', ['id', 'account_status', 'sms_2fa_enabled', 'sms_2fa_phone_e164']) ||
          !hasColumns('family_registration_root', ['id', 'root_user_id', 'created_at'])) return unavailable();
      const current = db.prepare('SELECT * FROM family_registration_root WHERE id=1').get();
      if (current && current.root_user_id !== rootUserId) return unavailable();
      if (!verifiedAccount(db.prepare('SELECT * FROM users WHERE id=?').get(rootUserId))) return unavailable();
      // The initialized read path performs no writes, including on read-only
      // audit connections. Bootstrap is serialized before rechecking identity.
      if (!current) {
        const initialized = db.transaction(() => {
          const persisted = db.prepare('SELECT root_user_id FROM family_registration_root WHERE id=1').get();
          if (persisted) return persisted.root_user_id === rootUserId;
          if (!verifiedAccount(db.prepare('SELECT * FROM users WHERE id=?').get(rootUserId))) return false;
          db.prepare('INSERT INTO family_registration_root(id,root_user_id,created_at) VALUES(1,?,?)')
            .run(rootUserId, new Date(now()).toISOString());
          return true;
        }).immediate();
        if (!initialized) return unavailable();
      }
      return { ok: true, rootUserId };
    } catch { return unavailable(); }
  }
  function rootedMember(userId, rootUserId) {
    const visited = new Set();
    let current = userId;
    while (current !== rootUserId) {
      if (!validId(current) || visited.has(current)) return false;
      visited.add(current);
      const membership = db.prepare('SELECT * FROM family_memberships WHERE user_id=?').get(current);
      if (!membership || membership.root_user_id !== rootUserId || !validId(membership.sponsor_user_id)) return false;
      // Ancestors are immutable identity facts. A blocked intermediate account
      // cannot invalidate a legitimate descendant's already completed lineage.
      current = membership.sponsor_user_id;
    }
    return true;
  }
  function findSponsor({ email, phone } = {}) {
    const config = configuration();
    if (!config.ok) return config;
    const cleanEmail = normalizeEmail(email), cleanPhone = normalizeAuthPhone(phone, env);
    if (!validateEmail(cleanEmail) || !cleanPhone) return ineligible();
    try {
      if (!hasColumns('beneficiaries', ['id', 'user_id', 'email', 'phone']) ||
          !hasColumns('family_memberships', ['user_id', 'root_user_id', 'sponsor_user_id', 'sponsor_beneficiary_id'])) return unavailable();
      const matches = db.prepare('SELECT id,user_id,email,phone FROM beneficiaries').all().filter(beneficiary => {
        if (normalizeEmail(beneficiary.email) !== cleanEmail || normalizeAuthPhone(beneficiary.phone, env) !== cleanPhone) return false;
        const sponsor = db.prepare('SELECT * FROM users WHERE id=?').get(beneficiary.user_id);
        return verifiedAccount(sponsor) && rootedMember(beneficiary.user_id, config.rootUserId) &&
          !db.prepare('SELECT 1 FROM family_memberships WHERE sponsor_beneficiary_id=?').get(beneficiary.id);
      });
      // Family members may save the same person. Choose a stable sponsor for a
      // new request; an already bound request is validated by its exact ID.
      matches.sort((first, second) => Number(second.user_id === config.rootUserId) - Number(first.user_id === config.rootUserId) || first.id - second.id);
      if (!matches.length) return ineligible();
      return { ok: true, sponsorUserId: matches[0].user_id, beneficiaryId: matches[0].id };
    } catch { return unavailable(); }
  }
  function validateBinding(request) {
    if (!request || request.eligibility_invalidated_at || !validId(request.family_sponsor_user_id) || !validId(request.family_beneficiary_id)) return ineligible();
    const config = configuration();
    if (!config.ok) return config;
    try {
      if (!hasColumns('beneficiaries', ['id', 'user_id', 'email', 'phone'])) return unavailable();
      const beneficiary = db.prepare('SELECT id,user_id,email,phone FROM beneficiaries WHERE id=?').get(request.family_beneficiary_id);
      const cleanEmail = normalizeEmail(request.email), cleanPhone = normalizeAuthPhone(request.phone_e164, env);
      if (!beneficiary || beneficiary.user_id !== request.family_sponsor_user_id || !validateEmail(cleanEmail) || !cleanPhone ||
          normalizeEmail(beneficiary.email) !== cleanEmail || normalizeAuthPhone(beneficiary.phone, env) !== cleanPhone ||
          !verifiedAccount(db.prepare('SELECT * FROM users WHERE id=?').get(beneficiary.user_id)) ||
          !rootedMember(beneficiary.user_id, config.rootUserId) ||
          db.prepare('SELECT 1 FROM family_memberships WHERE sponsor_beneficiary_id=?').get(beneficiary.id)) return ineligible();
      return { ok: true, sponsorUserId: beneficiary.user_id, beneficiaryId: beneficiary.id };
    } catch { return unavailable(); }
  }
  function enroll(request, userId) {
    if (!db.inTransaction) throw new Error('Family enrollment requires an account-creation transaction');
    try {
      if (!request || typeof request.id !== 'string' || !validId(userId) ||
          !hasColumns('registration_requests', ['id', 'status', 'registered_user_id', 'invitation_used_at',
            'decided_at', 'decided_by_user_id', 'family_sponsor_user_id', 'family_beneficiary_id', 'email', 'phone_e164'])) return ineligible();
      const persisted = db.prepare('SELECT * FROM registration_requests WHERE id=?').get(request.id);
      const user = db.prepare('SELECT * FROM users WHERE id=?').get(userId);
      if (!persisted || persisted.status !== 'registered' || persisted.registered_user_id !== userId ||
          !persisted.invitation_used_at || !persisted.decided_at || !validId(persisted.decided_by_user_id) ||
          !user || user.account_status !== 'registered_unverified' ||
          normalizeEmail(user.email) !== normalizeEmail(persisted.email) ||
          normalizeAuthPhone(user.sms_2fa_phone_e164, env) !== normalizeAuthPhone(persisted.phone_e164, env)) return ineligible();
      const binding = validateBinding(persisted);
      if (!binding.ok) return binding;
      const config = configuration();
      if (!config.ok) return config;
      db.prepare(`INSERT INTO family_memberships(user_id,root_user_id,sponsor_user_id,sponsor_beneficiary_id,
        source_registration_request_id,created_at) VALUES(?,?,?,?,?,?)`)
        .run(userId, config.rootUserId, binding.sponsorUserId, binding.beneficiaryId, persisted.id, new Date(now()).toISOString());
      return { ok: true, rootUserId: config.rootUserId, sponsorUserId: binding.sponsorUserId, beneficiaryId: binding.beneficiaryId };
    } catch { return ineligible(); }
  }
  return { configuration, findSponsor, validateBinding, enroll };
}
module.exports = { initFamilyRegistrationSchema, createFamilyRegistrationService };
