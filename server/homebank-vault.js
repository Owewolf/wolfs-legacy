'use strict';

const { classifyAccount, accountTypeId } = require('./homebank-classification');

// Linked vault records store identity and owner-supplied details. These fields
// are a read-time view of the current validated HomeBank snapshot, never a
// second persisted copy of its ledger.
const LEGACY_BALANCE_FIELDS = Object.freeze({
  bank_accounts: 'balance_approx',
  investments: 'value_approx',
  retirement: 'value_approx',
  debts: 'outstanding',
  real_estate: 'current_value',
  vehicles: 'loan_balance',
});
const FINANCIAL_SECTIONS = new Set(Object.keys(LEGACY_BALANCE_FIELDS));
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

function sourceBalanceField(section, account) {
  const type = accountTypeId(account);
  // Untyped old snapshots retain their former projection until reparsed.
  if (type === null) return LEGACY_BALANCE_FIELDS[section];
  if (type === 3) {
    if (section === 'vehicles' || section === 'real_estate') return 'current_value';
    if (section === 'investments' || section === 'retirement') return 'value_approx';
  } else if (type === 4 || type === 5) {
    if (section === 'debts') return 'outstanding';
    if (section === 'vehicles') return 'loan_balance';
    if (section === 'real_estate') return 'mortgage_balance';
  } else if ([1, 2, 6, 7].includes(type)) {
    if (section === 'bank_accounts') return 'balance_approx';
    if (section === 'investments' || section === 'retirement') return 'value_approx';
  }
  // A known source type cannot turn an asset into a debt or a liability into
  // an investment valuation merely because a stale record is in that form.
  return undefined;
}

function classificationFields(section, account, fields) {
  if (!FINANCIAL_SECTIONS.has(section)) return {};
  const classification = classifyAccount(account, section, fields);
  if (classification.section === section) return classification.fields;
  // Reconciliation normally moves this record before reads. Keep group
  // metadata usable on a historical placement without leaking a source debt
  // type into a vehicle/property type control.
  return { homebank_group: classification.fields.homebank_group || '' };
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
  if (accountTypeId(account) !== null && !sourceBalanceField(section, account)) return details;
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

function sanitizeHomebankEntry(entry, visibility, options = {}) {
  if (!isLinked(entry)) return entry;
  const fields = fieldsOf(entry);
  const account = visibility?.accountForEntry?.(entry);
  const balanceField = !account && options.preserveUnresolvedBalances
    ? undefined : sourceBalanceField(entry.section, account);
  if (balanceField) delete fields[balanceField];
  // Remove the former standalone ledger field from older views and backups.
  delete fields.homebank_balance;
  if (account) {
    for (const key of Object.keys(sourceDetailFields(entry.section, account))) delete fields[key];
    for (const key of Object.keys(classificationFields(entry.section, account, fields))) delete fields[key];
  }
  const result = { ...entry, fields, notes: '' };
  delete result.homebank_managed_fields;
  return result;
}

function projectHomebankEntry(entry, visibility) {
  if (!isLinked(entry)) return entry;
  const projected = sanitizeHomebankEntry(entry, visibility);
  const account = visibility?.accountForEntry?.(entry);
  const balanceField = sourceBalanceField(entry.section, account);
  const managed = ['notes', ...(balanceField ? [balanceField] : [])];
  if (account) {
    if (balanceField && typeof account.today === 'number' && Number.isFinite(account.today) &&
        currencyCode(account)) {
      // Keep the source sign, including credit balances on liability accounts.
      projected.fields[balanceField] = `${currencyCode(account)} ${account.today.toFixed(2)}`;
    }
    const details = {
      ...sourceDetailFields(entry.section, account),
      ...classificationFields(entry.section, account, fieldsOf(entry)),
    };
    Object.assign(projected.fields, details);
    managed.push(...Object.keys(details));
  }
  projected.homebank_managed_fields = managed;
  return projected;
}

function cleanupVisibility(db, decrypt) {
  // During startup the ordinary request visibility helper is unavailable.
  // Use the configured owner's same validated saved snapshot, including
  // hidden accounts: hidden linked assets also retain owner-entered loans.
  const tables = new Set(db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'
    AND name IN ('users', 'homebank_snapshots')`).all().map(row => row.name));
  // Pre-snapshot schema migration retains its legacy cleanup contract. Once
  // snapshots exist, unresolved accounts cannot authorize deleting a balance
  // that may be an owner's independently entered loan or mortgage.
  if (!tables.has('users') || !tables.has('homebank_snapshots')) return null;
  const unavailable = { accountForEntry: () => null };
  const email = String(process.env.HOMEBANK_OWNER_EMAIL || '').trim().toLowerCase();
  if (!email) return unavailable;
  const owner = db.prepare('SELECT id FROM users WHERE lower(trim(email)) = ?').get(email);
  if (!owner) return unavailable;
  const row = db.prepare('SELECT snapshot_encrypted FROM homebank_snapshots WHERE user_id = ?').get(owner.id);
  if (!row?.snapshot_encrypted) return unavailable;
  try {
    const snapshot = JSON.parse(decrypt(row.snapshot_encrypted));
    if (!snapshot || !Array.isArray(snapshot.accounts)) return unavailable;
    const accounts = new Map();
    for (const account of snapshot.accounts) {
      if (!account || !Number.isSafeInteger(account.id) || account.id <= 0 || accounts.has(account.id) ||
          typeof account.closed !== 'boolean' || typeof account.excluded_from_summary !== 'boolean') return unavailable;
      accounts.set(account.id, account);
    }
    return {
      accountForEntry(entry) {
        return Number(entry.user_id) === Number(owner.id) ? accounts.get(entry.homebank_account_id) || null : null;
      },
    };
  } catch {
    // A bad or unavailable source cannot authorize a different owner's data
    // or manufacture classification. Retain unresolved owner finance fields.
    return unavailable;
  }
}

function clearStoredHomebankLedger(db) {
  const { encrypt, decrypt } = require('./crypto');
  const visibility = cleanupVisibility(db, decrypt);
  const rows = db.prepare(`SELECT id, user_id, section, fields_encrypted, notes_encrypted, homebank_account_id
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
      const clean = sanitizeHomebankEntry({ ...row, fields }, visibility,
        { preserveUnresolvedBalances: visibility !== null });
      const serialized = JSON.stringify(clean.fields);
      const fieldsChanged = serialized !== JSON.stringify(fields);
      if (!fieldsChanged && row.notes_encrypted == null) continue;
      changes += update.run(fieldsChanged ? encrypt(serialized) : row.fields_encrypted, row.id).changes;
    }
    return changes;
  })();
}

module.exports = { projectHomebankEntry, sanitizeHomebankEntry, clearStoredHomebankLedger, sourceBalanceField };
