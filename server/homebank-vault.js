'use strict';

// Linked vault records store identity and owner-supplied details. These fields
// are a read-time view of the current validated HomeBank snapshot, never a
// second persisted copy of its ledger.
const BALANCE_FIELDS = Object.freeze({
  bank_accounts: 'balance_approx',
  investments: 'value_approx',
  retirement: 'value_approx',
  debts: 'outstanding',
  real_estate: 'current_value',
  vehicles: 'loan_balance',
});
const PROVIDER_PREFIXES = [
  ['First National Bank', 'First National Bank'],
  ['Rand Merchant Bank', 'Rand Merchant Bank'],
  ['Standard Bank', 'Standard Bank'],
  ['African Bank', 'African Bank'],
  ['SA Home Loans', 'SA Home Loans'],
  ['Investec', 'Investec'], ['Nedbank', 'Nedbank'], ['Capitec', 'Capitec'],
  ['WesBank', 'WesBank'], ['ABSA', 'ABSA'], ['FNB', 'FNB'], ['RMB', 'RMB'],
];

function isLinked(entry) {
  return entry && entry.homebank_account_id !== null && entry.homebank_account_id !== undefined;
}

function fieldsOf(entry) {
  return entry.fields && typeof entry.fields === 'object' && !Array.isArray(entry.fields)
    ? { ...entry.fields } : {};
}

function sourceText(account, key) {
  return typeof account?.[key] === 'string' ? account[key].trim() : '';
}

function currencyCode(account) {
  const value = sourceText(account, 'currency');
  return /^[A-Z]{3}$/.test(value) ? value : '';
}

function providerFromName(name) {
  if (typeof name !== 'string') return '';
  const normalized = name.trim().toLowerCase();
  for (const [prefix, provider] of PROVIDER_PREFIXES) {
    const lower = prefix.toLowerCase();
    if (normalized.startsWith(lower) &&
        (normalized.length === lower.length || !/[\p{L}\p{N}]/u.test(normalized[lower.length]))) {
      return provider;
    }
  }
  return '';
}

function sourceDetailFields(section, account) {
  const details = {};
  const bank = sourceText(account, 'bank_name');
  const number = sourceText(account, 'account_number') || sourceText(account, 'number');
  const website = sourceText(account, 'website');
  function set(key, value) { if (value) details[key] = value; }
  if (section === 'bank_accounts') {
    set('bank_name', bank);
    set('account_number', number);
    set('online_url', website);
  } else if (section === 'investments' || section === 'retirement') {
    set(section === 'investments' ? 'institution' : 'provider', bank);
    set('account_number', number);
    set('login_url', website);
  } else if (section === 'debts') {
    set('creditor', bank || providerFromName(account.name));
    set('account_number', number);
  } else if (section === 'vehicles') {
    // An asset's bank metadata does not establish a loan. Only an explicit
    // lender association may populate a vehicle's loan-provider field.
    set('loan_provider', sourceText(account, 'loan_provider'));
  } else if (section === 'real_estate') {
    set('mortgage_provider', sourceText(account, 'mortgage_provider') || sourceText(account, 'loan_provider'));
  }
  return details;
}

function sanitizeHomebankEntry(entry, visibility) {
  if (!isLinked(entry)) return entry;
  const fields = fieldsOf(entry);
  const balanceField = BALANCE_FIELDS[entry.section];
  if (balanceField) delete fields[balanceField];
  // Remove the former standalone ledger field from older views and backups.
  delete fields.homebank_balance;
  const account = visibility?.accountForEntry?.(entry);
  if (account) {
    for (const key of Object.keys(sourceDetailFields(entry.section, account))) delete fields[key];
  }
  const result = { ...entry, fields, notes: '' };
  delete result.homebank_managed_fields;
  return result;
}

function projectHomebankEntry(entry, visibility) {
  if (!isLinked(entry)) return entry;
  const projected = sanitizeHomebankEntry(entry, visibility);
  const balanceField = BALANCE_FIELDS[entry.section];
  const managed = ['notes', ...(balanceField ? [balanceField] : [])];
  const account = visibility?.accountForEntry?.(entry);
  if (account) {
    if (balanceField && typeof account.today === 'number' && Number.isFinite(account.today) &&
        currencyCode(account)) {
      // Keep the source sign, including credit balances on liability accounts.
      projected.fields[balanceField] = `${currencyCode(account)} ${account.today.toFixed(2)}`;
    }
    const details = sourceDetailFields(entry.section, account);
    Object.assign(projected.fields, details);
    managed.push(...Object.keys(details));
  }
  projected.homebank_managed_fields = managed;
  return projected;
}

function clearStoredHomebankLedger(db) {
  const { encrypt, decrypt } = require('./crypto');
  const rows = db.prepare(`SELECT id, section, fields_encrypted, notes_encrypted, homebank_account_id
    FROM vault_entries WHERE homebank_account_id IS NOT NULL`).all();
  const update = db.prepare(`UPDATE vault_entries SET fields_encrypted = ?, notes_encrypted = NULL
    WHERE id = ? AND homebank_account_id IS NOT NULL`);
  return db.transaction(() => {
    let changes = 0;
    for (const row of rows) {
      let fields;
      try { fields = JSON.parse(decrypt(row.fields_encrypted)); } catch { continue; }
      // A corrupt record must remain available for recovery instead of being
      // replaced with an empty object during a schema upgrade.
      if (!fields || typeof fields !== 'object' || Array.isArray(fields)) continue;
      const clean = sanitizeHomebankEntry({ ...row, fields });
      const serialized = JSON.stringify(clean.fields);
      const fieldsChanged = serialized !== JSON.stringify(fields);
      if (!fieldsChanged && row.notes_encrypted == null) continue;
      changes += update.run(fieldsChanged ? encrypt(serialized) : row.fields_encrypted, row.id).changes;
    }
    return changes;
  })();
}

module.exports = { projectHomebankEntry, sanitizeHomebankEntry, clearStoredHomebankLedger };
