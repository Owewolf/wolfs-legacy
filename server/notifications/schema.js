'use strict';

function initNotificationSchema(db) {
  db.transaction(() => {
    const columns = db.prepare('PRAGMA table_info(dead_switch_config)').all();
    if (!columns.some(c => c.name === 'notification_cycle_id')) {
      db.exec('ALTER TABLE dead_switch_config ADD COLUMN notification_cycle_id TEXT');
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS notification_settings (
        user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        recipient TEXT, verified_at TEXT, reply_enabled INTEGER NOT NULL DEFAULT 0 CHECK(reply_enabled IN (0,1)),
        timezone TEXT NOT NULL DEFAULT 'Africa/Johannesburg', reminder_clock TEXT,
        config_status TEXT NOT NULL DEFAULT 'ready', verify_nonce TEXT, verify_hash TEXT,
        verify_expires_at TEXT, verify_attempts INTEGER NOT NULL DEFAULT 0, updated_at TEXT
      );
      CREATE TABLE IF NOT EXISTS notification_cycles (
        id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        last_checkin_at TEXT NOT NULL, due_at TEXT NOT NULL, expiry_at TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('open','superseded','released','disabled')),
        created_at TEXT NOT NULL, reason TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_notification_cycles_owner ON notification_cycles(user_id,status);
      CREATE TABLE IF NOT EXISTS notification_outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT, event_type TEXT NOT NULL,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, beneficiary_id INTEGER,
        cycle_id TEXT, idempotency_key TEXT NOT NULL UNIQUE, schedule_at TEXT NOT NULL,
        reminder_number INTEGER CHECK(reminder_number BETWEEN 1 AND 5), reminder_date TEXT,
        data_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN
          ('queued','sending','sent_to_server','delivered','failed','retried','dead_letter','cancelled','uncertain')),
        attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT, locked_at TEXT,
        message_id TEXT UNIQUE, last_error TEXT, sent_at TEXT, delivery_confirmed_at TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(cycle_id,reminder_number)
      );
      CREATE INDEX IF NOT EXISTS idx_notification_outbox_due ON notification_outbox(status,schedule_at,next_attempt_at);
      CREATE TABLE IF NOT EXISTS notification_attempts (
        id INTEGER PRIMARY KEY, outbox_id INTEGER NOT NULL REFERENCES notification_outbox(id) ON DELETE CASCADE,
        attempt_number INTEGER NOT NULL, outcome TEXT NOT NULL, provider_code TEXT, created_at TEXT NOT NULL,
        UNIQUE(outbox_id,attempt_number)
      );
      CREATE TABLE IF NOT EXISTS checkin_challenges (
        id TEXT PRIMARY KEY, code_hash TEXT NOT NULL UNIQUE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, cycle_id TEXT NOT NULL,
        outbox_id INTEGER NOT NULL UNIQUE REFERENCES notification_outbox(id), message_id TEXT NOT NULL,
        issued_at TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT, revoked_at TEXT,
        inbound_identity TEXT, reminder_sequence INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS checkin_recovery_codes (
        id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        batch_id TEXT NOT NULL, code_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL,
        consumed_at TEXT, revoked_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_checkin_recovery_owner ON checkin_recovery_codes(user_id);
      CREATE TABLE IF NOT EXISTS inbound_message_log (
        identity TEXT PRIMARY KEY, message_fingerprint TEXT UNIQUE, user_id INTEGER,
        cycle_id TEXT, outcome TEXT NOT NULL, reason TEXT NOT NULL, authentication_status TEXT,
        received_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_inbound_owner_time ON inbound_message_log(user_id,received_at);
      CREATE TABLE IF NOT EXISTS inbound_checkpoints (
        account TEXT NOT NULL, mailbox TEXT NOT NULL, uid_validity TEXT NOT NULL, last_uid INTEGER NOT NULL,
        PRIMARY KEY(account,mailbox,uid_validity)
      );
      CREATE TABLE IF NOT EXISTS notification_reminder_days (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, local_date TEXT NOT NULL,
        outbox_id INTEGER NOT NULL REFERENCES notification_outbox(id), PRIMARY KEY(user_id,local_date)
      );
      CREATE TABLE IF NOT EXISTS notification_health (
        channel TEXT PRIMARY KEY, status TEXT NOT NULL, failures INTEGER NOT NULL DEFAULT 0,
        first_failed_at TEXT, last_failure_at TEXT, last_success_at TEXT, last_error TEXT, alerted_at TEXT
      );
    `);
  })();
}

module.exports = { initNotificationSchema };
