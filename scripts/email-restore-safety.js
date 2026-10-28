#!/usr/bin/env node
'use strict';

// Standalone on purpose: never initialize the app, generate keys or open its DB.
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

function quarantine(databasePath) {
  if (!path.isAbsolute(databasePath)) throw new Error('An absolute restored database path is required');
  const stat = fs.lstatSync(databasePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Expected an existing regular database file, not a symlink');
  const db = new Database(databasePath, { fileMustExist: true, timeout: 1000 });
  try {
    const integrity = db.pragma('quick_check');
    if (integrity.length !== 1 || integrity[0].quick_check !== 'ok') throw new Error('Database integrity check failed');
    const expected = {
      notification_settings: ['reply_enabled', 'config_status', 'verified_at', 'verify_hash', 'verify_nonce', 'verify_expires_at', 'updated_at'],
      notification_outbox: ['status', 'updated_at', 'locked_at'],
      checkin_challenges: ['used_at', 'revoked_at'],
      checkin_recovery_codes: ['consumed_at', 'revoked_at'],
      notification_cycles: ['status'],
      notification_health: ['channel', 'status', 'failures', 'last_failure_at', 'last_error']
    };
    const present = Object.keys(expected).filter(table => db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
    if (present.length === 0) return { result: 'no_email_schema', changed: false };
    if (present.length !== Object.keys(expected).length) throw new Error('Incomplete email schema; no changes made');
    for (const [table, fields] of Object.entries(expected)) {
      const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(column => column.name));
      if (fields.some(field => !columns.has(field))) throw new Error('Unsupported email schema; no changes made');
    }
    const at = new Date().toISOString();
    return db.transaction(() => {
      const settings = db.prepare(`UPDATE notification_settings SET reply_enabled=0, config_status='restore_review',
        verified_at=NULL, verify_hash=NULL, verify_nonce=NULL, verify_expires_at=NULL, updated_at=?`).run(at).changes;
      const outbox = db.prepare(`UPDATE notification_outbox SET status='cancelled', locked_at=NULL, updated_at=?
        WHERE status IN ('queued','retried','sending','failed','uncertain')`).run(at).changes;
      const challenges = db.prepare('UPDATE checkin_challenges SET revoked_at=? WHERE used_at IS NULL AND revoked_at IS NULL').run(at).changes;
      const recoveryCodes = db.prepare('UPDATE checkin_recovery_codes SET revoked_at=? WHERE consumed_at IS NULL AND revoked_at IS NULL').run(at).changes;
      const cycles = db.prepare("UPDATE notification_cycles SET status='superseded' WHERE status='open'").run().changes;
      db.prepare(`INSERT INTO notification_health (channel,status,failures,last_failure_at,last_error)
        VALUES ('restore','degraded',1,?,'restore_review_required')
        ON CONFLICT(channel) DO UPDATE SET status='degraded',last_failure_at=excluded.last_failure_at,
        last_error='restore_review_required'`).run(at);
      return { result: 'quarantined', changed: true, settings, outbox, challenges, recoveryCodes, cycles };
    }).exclusive();
  } finally { db.close(); }
}

function main(args) {
  if (args.length !== 2 || args[0] !== '--service-stopped') {
    process.stderr.write('Usage: node scripts/email-restore-safety.js --service-stopped /absolute/restored/vault.db\nStop all app/mail workers and preserve a complete backup before running.\n');
    return 2;
  }
  try {
    process.stdout.write(JSON.stringify(quarantine(args[1])) + '\n');
    return 0;
  } catch {
    // Filesystem/SQLite errors can include sensitive paths or SQL values.
    process.stderr.write('Restore quarantine failed. Check the existing database file, schema, integrity and exclusive access; keep the service stopped.\n');
    return 1;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { quarantine, main };
