'use strict';

// HomeBank IDs are durable links: editing a title or notes never changes which
// source account controls an imported vault record's visibility.
function homebankAccountIdFromNotes(notes) {
  if (typeof notes !== 'string' || !/^Imported from HomeBank on \d{4}-\d{2}-\d{2}\.\r?(?:\n|$)/.test(notes) ||
      !/^Source file: [^\r\n/\\]+\.xhb\r?$/mi.test(notes)) return null;
  const matches = [...notes.matchAll(/^HomeBank account ID: ([1-9]\d*)\r?$/gm)];
  if (matches.length !== 1) return null;
  const id = Number(matches[0][1]);
  return Number.isSafeInteger(id) ? id : null;
}

function createVaultVisibility(options = {}) {
  // Keep getDb lazy so schema initialization can run the backfill without a
  // circular require, and tests can supply an isolated database and decoder.
  const getDb = options.getDb || (() => require('./db').getDb());
  const decrypt = options.decrypt || require('./crypto').decrypt;
  const ownerEmail = () => String(typeof options.ownerEmail === 'function' ? options.ownerEmail() :
    (options.ownerEmail === undefined ? process.env.HOMEBANK_OWNER_EMAIL || '' : options.ownerEmail))
    .trim().toLowerCase();

  function configuredOwner(db) {
    const email = ownerEmail();
    if (!email) return null;
    return db.prepare('SELECT id, email FROM users WHERE lower(trim(email)) = ?').get(email) || null;
  }

  function backfillHomeBankLinks(db = getDb()) {
    const owner = configuredOwner(db);
    if (!owner) return 0;
    const candidates = db.prepare(`SELECT id, notes_encrypted FROM vault_entries
      WHERE user_id = ? AND homebank_account_id IS NULL AND notes_encrypted IS NOT NULL`).all(owner.id);
    const update = db.prepare(`UPDATE vault_entries SET homebank_account_id = ?
      WHERE id = ? AND user_id = ? AND homebank_account_id IS NULL`);
    return db.transaction(() => {
      let changes = 0;
      for (const entry of candidates) {
        let id;
        try { id = homebankAccountIdFromNotes(decrypt(entry.notes_encrypted)); } catch { continue; }
        if (id !== null) changes += update.run(id, entry.id, owner.id).changes;
      }
      return changes;
    })();
  }

  function forUser(userId) {
    const db = getDb();
    const owner = configuredOwner(db);
    const allowed = new Set();
    const accounts = new Map();
    let ledgerDate = null;
    if (owner && Number(owner.id) === Number(userId)) {
      const row = db.prepare('SELECT snapshot_encrypted FROM homebank_snapshots WHERE user_id = ?').get(userId);
      if (row && row.snapshot_encrypted) {
        try {
          // The sync service retains the previous validated snapshot on source
          // read errors. Do not discard it because last_error is populated.
          const snapshot = JSON.parse(decrypt(row.snapshot_encrypted));
          if (!snapshot || !Array.isArray(snapshot.accounts)) throw new Error('Invalid HomeBank snapshot');
          const seen = new Set();
          for (const account of snapshot.accounts) {
            if (!account || !Number.isSafeInteger(account.id) || account.id <= 0 || seen.has(account.id) ||
                typeof account.closed !== 'boolean' || typeof account.excluded_from_summary !== 'boolean') {
              throw new Error('Invalid HomeBank account');
            }
            seen.add(account.id);
            accounts.set(account.id, account);
            if (!account.closed && !account.excluded_from_summary) allowed.add(account.id);
          }
          ledgerDate = typeof snapshot.exported_date === 'string' ? snapshot.exported_date : null;
        } catch {
          // A missing or corrupt snapshot must never expose linked accounts.
          allowed.clear();
          accounts.clear();
          ledgerDate = null;
        }
      }
    }
    function isVisible(entry) {
      if (!entry || Number(entry.user_id) !== Number(userId)) return false;
      if (entry.homebank_account_id === null || entry.homebank_account_id === undefined) return true;
      return allowed.has(entry.homebank_account_id);
    }
    // Projection and visibility share a single validated snapshot for the
    // request, so an account cannot pass one source version's filters while
    // displaying another source version's ledger.
    function accountForEntry(entry) {
      return isVisible(entry) && entry.homebank_account_id != null
        ? accounts.get(entry.homebank_account_id) || null : null;
    }
    return { isVisible, filter: entries => entries.filter(isVisible), accountForEntry, ledgerDate };
  }

  return { forUser, backfillHomeBankLinks };
}

const visibility = createVaultVisibility();
module.exports = {
  createVaultVisibility,
  getVaultVisibility: visibility.forUser,
  backfillHomeBankLinks: visibility.backfillHomeBankLinks,
  homebankAccountIdFromNotes,
};
