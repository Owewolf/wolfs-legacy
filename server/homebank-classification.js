'use strict';

// HomeBank account types describe a broad ledger class. Explicit, recognizable
// account groups can supply a more specific vault purpose; transaction expense
// categories and the sign of a balance never determine that purpose.
const FINANCIAL = new Set(['bank_accounts', 'investments', 'retirement', 'debts', 'real_estate', 'vehicles']);
const TYPE_IDS = { uncategorised: 0, uncategorized: 0, none: 0, bank: 1, cash: 2,
  asset: 3, creditcard: 4, liability: 5, checking: 6, savings: 7 };
const normalized = value => typeof value === 'string'
  ? value.normalize('NFKC').trim().toLowerCase().replace(/[_–—-]/g, ' ').replace(/\s+/g, ' ') : '';

function accountTypeId(account) {
  if (Number.isInteger(account?.type_id) && account.type_id >= 0 && account.type_id <= 7) return account.type_id;
  const name = normalized(account?.type).replace(/\s/g, '');
  return Object.hasOwn(TYPE_IDS, name) ? TYPE_IDS[name] : null;
}

function groupClassification(value) {
  const name = normalized(value);
  if (/^retirement annuit(?:y|ies)$/.test(name)) return { section: 'retirement', type: 'Annuity' };
  if (/^pension(?: funds?)?$/.test(name)) return { section: 'retirement', type: 'Pension' };
  if (/^provident(?: funds?)?$/.test(name)) return { section: 'retirement', type: 'Provident Fund' };
  if (/^(?:retirement|retirement accounts?)$/.test(name)) return { section: 'retirement' };
  if (/^(?:investments?|investment accounts?)$/.test(name)) return { section: 'investments' };
  if (/^(?:bank accounts?|banking|cash accounts?)$/.test(name)) return { section: 'bank_accounts' };
  if (/^(?:real estate|properties|property)$/.test(name)) return { section: 'real_estate' };
  if (/^(?:vehicles?|motor vehicles?)$/.test(name)) return { section: 'vehicles' };
  if (/^credit cards?$/.test(name)) return { section: 'debts', type: 'Credit Card' };
  if (/^mortgages?$/.test(name)) return { section: 'debts', type: 'Mortgage' };
  if (/^(?:vehicle|car) loans?$/.test(name)) return { section: 'debts', type: 'Car Loan' };
  if (/^(?:debts?|liabilit(?:y|ies)|loans?)$/.test(name)) return { section: 'debts' };
  return null;
}

function institutionName(value) {
  // Match a saved owner rule exactly, allowing only presentation differences.
  // Punctuation such as hyphens remains significant; an institution's name
  // alone never establishes an allocation without an explicit matching rule.
  return typeof value === 'string' ? value.normalize('NFKC').replace(/[‘’‛ʼ]/g, "'")
    .trim().toLowerCase().replace(/\s+/g, ' ') : '';
}

function institutionAllocation(account, options) {
  const rules = options?.institutionAllocations;
  const name = institutionName(account?.bank_name);
  if (!name || !Array.isArray(rules)) return undefined;
  let section;
  for (const rule of rules) {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule) ||
        !['vehicles', 'real_estate'].includes(rule.section) ||
        institutionName(rule.institution) !== name) continue;
    // Equivalent rules are harmless, but conflicting allocations must never
    // choose a purpose based on their order in the private configuration.
    if (section && section !== rule.section) return undefined;
    section = rule.section;
  }
  return section;
}

function classifyAccount(account, existingSection, options = {}) {
  const kind = accountTypeId(account);
  const group = groupClassification(account?.group_name);
  const allocation = kind === 3 ? institutionAllocation(account, options) : undefined;
  let section = existingSection;
  // Credit/liability ledgers remain debts even when their group names describe
  // the asset they finance. Generic Savings alone cannot distinguish a cash
  // account from an investment or pension already deliberately categorized.
  if (kind === 4 || kind === 5) section = 'debts';
  else if (allocation) section = allocation;
  else if (group) section = group.section;
  else if (kind === 6 || kind === 2) section = 'bank_accounts';
  else if ((kind === 1 || kind === 7) && !['investments', 'retirement'].includes(existingSection)) section = 'bank_accounts';
  const fields = {};
  if (FINANCIAL.has(section)) fields.homebank_group = typeof account?.group_name === 'string' ? account.group_name.trim() : '';
  if (section === 'bank_accounts') {
    const type = { 1: 'Bank', 2: 'Cash', 6: 'Current / Checking', 7: 'Savings' }[kind];
    if (type) fields.account_type = type;
  }
  if (section === 'debts' && kind === 4) fields.type = 'Credit Card';
  else if (group && group.section === section && group.type) fields.type = group.type;
  return { section, fields };
}

function reallocatedFields(fields, previous, next) {
  const result = { ...fields };
  if (previous === next) return result;
  const providers = { bank_accounts: 'bank_name', investments: 'institution', retirement: 'provider', debts: 'creditor' };
  const before = providers[previous], after = providers[next];
  if (before && after && before !== after) {
    if (!result[after] && result[before]) result[after] = result[before];
    if (!result[before] || result[after] === result[before]) delete result[before];
  }
  if (next === 'retirement' && ['bank_accounts', 'investments'].includes(previous)) {
    if (!result.investment_type) result.investment_type = result.account_type || result.type || '';
    if (!result.investment_type) delete result.investment_type;
    if (!result.beneficiary && result.nominee) result.beneficiary = result.nominee;
    if (!result.nominee || result.beneficiary === result.nominee) delete result.nominee;
  } else if (previous === 'retirement' && ['bank_accounts', 'investments'].includes(next)) {
    if (!result.nominee && result.beneficiary) result.nominee = result.beneficiary;
    if (!result.beneficiary || result.nominee === result.beneficiary) delete result.beneficiary;
  }
  const beforeUrl = previous === 'bank_accounts' ? 'online_url' : ['investments', 'retirement'].includes(previous) ? 'login_url' : null;
  const afterUrl = next === 'bank_accounts' ? 'online_url' : ['investments', 'retirement'].includes(next) ? 'login_url' : null;
  if (beforeUrl && afterUrl && beforeUrl !== afterUrl) {
    if (!result[afterUrl] && result[beforeUrl]) result[afterUrl] = result[beforeUrl];
    if (!result[beforeUrl] || result[afterUrl] === result[beforeUrl]) delete result[beforeUrl];
  }
  if (previous === 'bank_accounts' && next !== 'bank_accounts') delete result.account_type;
  return result;
}

function alignHomebankEntry(entry, visibility) {
  if (entry?.homebank_account_id == null) return entry;
  const account = visibility?.accountForEntry?.(entry);
  if (!account) return entry;
  const { section } = classifyAccount(account, entry.section, visibility?.classificationOptions);
  if (section === entry.section) return entry;
  const fields = reallocatedFields(entry.fields || {}, entry.section, section);
  const previousBalance = require('./homebank-vault').sourceBalanceField(entry.section, account);
  if (previousBalance) delete fields[previousBalance];
  return { ...entry, section, fields };
}

function reconcileHomebankClassifications(db, userId, snapshot, options = {}) {
  const empty = () => ({ changed: 0, skipped: 0 });
  const email = String(options.ownerEmail ?? process.env.HOMEBANK_OWNER_EMAIL ?? '').trim().toLowerCase();
  if (!email || snapshot?.snapshot_schema_version !== 3 || !Array.isArray(snapshot.accounts)) return empty();
  const owner = db.prepare('SELECT id FROM users WHERE lower(trim(email)) = ?').get(email);
  if (!owner || Number(owner.id) !== Number(userId)) return empty();
  const accounts = new Map();
  for (const account of snapshot.accounts) {
    if (!Number.isSafeInteger(account?.id) || account.id <= 0 || accounts.has(account.id) ||
        typeof account.closed !== 'boolean' || typeof account.excluded_from_summary !== 'boolean') return empty();
    accounts.set(account.id, account);
  }
  // Load lazily to keep pure classification independent of database startup and
  // avoid a module-load cycle with the source-field projection layer.
  const { encrypt, decrypt } = require('./crypto');
  const { sourceBalanceField, sanitizeHomebankEntry } = require('./homebank-vault');
  const rows = db.prepare(`SELECT id,user_id,section,fields_encrypted,notes_encrypted,homebank_account_id
    FROM vault_entries WHERE user_id=? AND homebank_account_id IS NOT NULL`).all(userId);
  const update = db.prepare('UPDATE vault_entries SET section=?,fields_encrypted=? WHERE id=? AND user_id=?');
  return db.transaction(() => {
    let changed = 0, skipped = 0;
    for (const row of rows) {
      const account = accounts.get(row.homebank_account_id);
      if (!account) { skipped++; continue; }
      let original;
      try { original = JSON.parse(decrypt(row.fields_encrypted)); } catch { skipped++; continue; }
      if (!original || typeof original !== 'object' || Array.isArray(original)) { skipped++; continue; }
      const { section } = classifyAccount(account, row.section, options);
      const fields = reallocatedFields(original, row.section, section);
      if (section !== row.section) {
        const formerBalance = sourceBalanceField(row.section, account);
        if (formerBalance) delete fields[formerBalance];
      }
      const clean = sanitizeHomebankEntry({ ...row, section, fields },
        { accountForEntry: () => account, classificationOptions: options });
      const serialized = JSON.stringify(clean.fields);
      if (section === row.section && serialized === JSON.stringify(original)) continue;
      if (!options.dryRun) update.run(section, serialized === JSON.stringify(original) ? row.fields_encrypted : encrypt(serialized), row.id, userId);
      changed++;
    }
    return { changed, skipped };
  })();
}

function importableAccounts(snapshot) {
  if (snapshot?.snapshot_schema_version !== 3 || !Array.isArray(snapshot.accounts)) {
    throw new Error('Invalid HomeBank account snapshot; keeping previous validated snapshot');
  }
  const accounts = new Map();
  for (const account of snapshot.accounts) {
    if (!account || !Number.isSafeInteger(account.id) || account.id <= 0 || accounts.has(account.id) ||
        typeof account.closed !== 'boolean' || typeof account.excluded_from_summary !== 'boolean' ||
        typeof account.name !== 'string' ||
        (account.group_name != null && typeof account.group_name !== 'string') ||
        (account.type_id != null && (!Number.isSafeInteger(account.type_id) || account.type_id < 0)) ||
        (account.type != null && typeof account.type !== 'string')) {
      throw new Error('Invalid HomeBank account snapshot; keeping previous validated snapshot');
    }
    accounts.set(account.id, account);
  }
  return accounts;
}

function reconcileHomebankAccounts(db, userId, snapshot, options = {}) {
  // Validate every account before any existing record is changed or a missing
  // record is created. The service includes this in its snapshot transaction.
  const accounts = importableAccounts(snapshot);
  const empty = () => ({ created: 0, changed: 0, skipped: 0 });
  const email = String(options.ownerEmail ?? process.env.HOMEBANK_OWNER_EMAIL ?? '').trim().toLowerCase();
  if (!email) return empty();
  const owner = db.prepare('SELECT id FROM users WHERE lower(trim(email)) = ?').get(email);
  if (!owner || Number(owner.id) !== Number(userId)) return empty();
  const { encrypt } = require('./crypto');
  // An immediate transaction also serializes cache-path imports across app
  // processes. Existing links are checked under that same write lock.
  return db.transaction(() => {
    const aligned = reconcileHomebankClassifications(db, userId, snapshot, options);
    const linked = new Set(db.prepare(`SELECT homebank_account_id FROM vault_entries
      WHERE user_id=? AND homebank_account_id IS NOT NULL`).all(userId).map(row => row.homebank_account_id));
    const insert = db.prepare(`INSERT INTO vault_entries
      (user_id,section,title,fields_encrypted,notes_encrypted,homebank_account_id)
      VALUES (?,?,?,?,NULL,?)`);
    let created = 0;
    for (const account of accounts.values()) {
      if (account.closed || account.excluded_from_summary || linked.has(account.id)) continue;
      // An ungrouped asset needs a generic asset form; other unclassified
      // ledgers use a bank account form until HomeBank supplies a purpose.
      // Names, transaction categories and balance signs never infer purpose.
      const fallback = accountTypeId(account) === 3 ? 'investments' : 'bank_accounts';
      const { section } = classifyAccount(account, fallback, options);
      if (!options.dryRun) insert.run(userId, section, account.name.trim() || `HomeBank account ${account.id}`,
        encrypt('{}'), account.id);
      linked.add(account.id);
      created++;
    }
    return { created, ...aligned };
  }).immediate();
}

module.exports = { accountTypeId, classifyAccount, alignHomebankEntry, reconcileHomebankClassifications,
  reconcileHomebankAccounts };
