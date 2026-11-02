const Database = require('better-sqlite3');
const path = require('path');
const { initSmsOtpSchema } = require('./sms-otp');

const DB_PATH = path.join(__dirname, '..', 'data', 'vault.db');
let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initTables();
  }
  return db;
}

function initTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      totp_secret TEXT,
      totp_enabled INTEGER DEFAULT 0,
      sms_2fa_phone_e164 TEXT,
      sms_2fa_enabled INTEGER DEFAULT 0,
      sms_2fa_enrolled_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_check_in DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS dead_switch_config (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL UNIQUE,
      check_in_interval_days INTEGER DEFAULT 30 CHECK(check_in_interval_days BETWEEN 1 AND 365),
      grace_period_days INTEGER DEFAULT 7 CHECK(grace_period_days BETWEEN 1 AND 90),
      is_active INTEGER DEFAULT 0,
      switch_triggered INTEGER DEFAULT 0,
      switch_triggered_at DATETIME,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS beneficiaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      email TEXT,
      phone TEXT,
      relationship TEXT,
      access_token TEXT UNIQUE,
      token_expires_at DATETIME,
      emergency_access_requested INTEGER DEFAULT 0,
      emergency_access_requested_at DATETIME,
      emergency_waiting_days INTEGER DEFAULT 7 CHECK(emergency_waiting_days BETWEEN 1 AND 90),
      access_granted INTEGER DEFAULT 0,
      access_granted_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS vault_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      section TEXT NOT NULL,
      title TEXT NOT NULL,
      fields_encrypted TEXT NOT NULL,
      notes_encrypted TEXT,
      homebank_account_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS managed_documents (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      original_name_encrypted TEXT NOT NULL,
      display_name_encrypted TEXT NOT NULL,
      description_encrypted TEXT,
      stored_filename TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS document_associations (
      document_id TEXT NOT NULL REFERENCES managed_documents(id) ON DELETE CASCADE,
      entry_id INTEGER NOT NULL REFERENCES vault_entries(id) ON DELETE CASCADE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (document_id, entry_id)
    );
    CREATE INDEX IF NOT EXISTS idx_docs_owner ON managed_documents(user_id);
    CREATE INDEX IF NOT EXISTS idx_doc_associations_entry ON document_associations(entry_id);

    CREATE TABLE IF NOT EXISTS homebank_snapshots (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      config_encrypted TEXT NOT NULL,
      snapshot_encrypted TEXT,
      fingerprint TEXT,
      source_file TEXT,
      source_saved_at TEXT,
      synced_at TEXT,
      last_error TEXT,
      content_hash TEXT
    );
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      action TEXT NOT NULL,
      target_type TEXT,
      target_id INTEGER,
      detail TEXT,
      ip_address TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_vault_entries_user_section ON vault_entries(user_id, section);
    CREATE INDEX IF NOT EXISTS idx_vault_entries_user ON vault_entries(user_id);
    CREATE INDEX IF NOT EXISTS idx_beneficiaries_user ON beneficiaries(user_id);
    CREATE INDEX IF NOT EXISTS idx_beneficiaries_token ON beneficiaries(access_token);
    CREATE INDEX IF NOT EXISTS idx_audit_log_user ON audit_log(user_id);
    CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at);
  `);

  // Add columns to existing tables if missing (safe migration)
  const cols = db.prepare("PRAGMA table_info(beneficiaries)").all().map(c => c.name);
  if (!cols.includes('token_expires_at')) {
    db.exec('ALTER TABLE beneficiaries ADD COLUMN token_expires_at DATETIME');
  }
  const userCols = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
  if (!userCols.includes('totp_secret')) {
    db.exec('ALTER TABLE users ADD COLUMN totp_secret TEXT');
    db.exec('ALTER TABLE users ADD COLUMN totp_enabled INTEGER DEFAULT 0');
  }
  if (!userCols.includes('sms_2fa_phone_e164')) {
    db.exec('ALTER TABLE users ADD COLUMN sms_2fa_phone_e164 TEXT');
  }
  if (!userCols.includes('sms_2fa_enabled')) {
    db.exec('ALTER TABLE users ADD COLUMN sms_2fa_enabled INTEGER DEFAULT 0');
  }
  if (!userCols.includes('sms_2fa_enrolled_at')) {
    db.exec('ALTER TABLE users ADD COLUMN sms_2fa_enrolled_at DATETIME');
  }
  const vaultCols = db.prepare('PRAGMA table_info(vault_entries)').all().map(c => c.name);
  if (!vaultCols.includes('homebank_account_id')) {
    db.exec('ALTER TABLE vault_entries ADD COLUMN homebank_account_id INTEGER');
  }
  initSmsOtpSchema(db);
  // Secrets are loaded before getDb() at startup. Record the existing HomeBank
  // provenance before dropping copied ledger fields and notes. The source link,
  // owner-supplied details, documents and timestamps stay intact; financial
  // values are projected from the current snapshot on every read.
  require('./vault-visibility').backfillHomeBankLinks(db);
  require('./homebank-vault').clearStoredHomebankLedger(db);
  require('./notifications/schema').initNotificationSchema(db);
  require('./legacy-schema').initLegacySchema(db);
}

function audit(userId, action, targetType, targetId, detail, ip) {
  try {
    getDb().prepare(
      'INSERT INTO audit_log (user_id, action, target_type, target_id, detail, ip_address) VALUES (?,?,?,?,?,?)'
    ).run(userId, action, targetType || null, targetId || null, detail || null, ip || null);
  } catch { /* never let audit failure break the app */ }
}

module.exports = { getDb, audit };
