const { decrypt } = require('./crypto');
const { normalizePhoneE164 } = require('./sms-otp');

function smsAuthRequired(env = process.env) {
  return env.AUTH_SMS_REQUIRED === 'true';
}

function normalizeAuthPhone(value, env = process.env) {
  if (typeof value !== 'string') return null;
  const compact = value.trim().replace(/[\s()-]/g, '');
  const international = compact.startsWith('00') ? `+${compact.slice(2)}` : compact;
  const normalized = normalizePhoneE164(international);
  if (normalized) return normalized;
  const country = String(env.SMS_DEFAULT_COUNTRY_CODE || '27').replace(/^\+/, '');
  if (!/^[1-9]\d{0,2}$/.test(country) || !/^0\d{9}$/.test(compact)) return null;
  return normalizePhoneE164(`+${country}${compact.slice(1)}`);
}

function resolveSavedPhone(db, user, env = process.env, decryptFields = decrypt) {
  const saved = normalizeAuthPhone(user.sms_2fa_phone_e164, env);
  if (saved) return { phone: saved, source: 'account' };
  // An enrolled authentication number must be repaired through authenticated
  // account recovery, rather than replaced by a profile or setup request.
  if (user.sms_2fa_enabled) return { phone: null, reason: 'enrolled_phone_unavailable' };
  const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='vault_entries'").get();
  if (!table) return { phone: null, reason: 'phone_missing' };
  const phones = new Set();
  const rows = db.prepare("SELECT fields_encrypted FROM vault_entries WHERE user_id=? AND section='personal'").all(user.id);
  for (const row of rows) {
    try {
      const fields = JSON.parse(decryptFields(row.fields_encrypted));
      const phone = normalizeAuthPhone(fields?.mobile_phone, env);
      if (phone) phones.add(phone);
    } catch { /* An unreadable profile cannot supply an authentication phone. */ }
  }
  if (phones.size === 1) return { phone: [...phones][0], source: 'personal' };
  return { phone: null, reason: phones.size ? 'phone_ambiguous' : 'phone_missing' };
}

module.exports = { smsAuthRequired, normalizeAuthPhone, resolveSavedPhone };
