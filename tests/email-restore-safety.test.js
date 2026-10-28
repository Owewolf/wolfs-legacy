'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const Database = require('better-sqlite3');
const { initNotificationSchema } = require('../server/notifications/schema');
const { quarantine } = require('../scripts/email-restore-safety');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-restore-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const databasePath = path.join(directory, 'restored.db');
  const db = new Database(databasePath);
  t.after(() => db.close());
  db.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY, last_check_in TEXT);
    CREATE TABLE dead_switch_config(id INTEGER PRIMARY KEY,user_id INTEGER,switch_triggered INTEGER);
    CREATE TABLE vault_entries(id INTEGER PRIMARY KEY,fields_encrypted TEXT);
    CREATE TABLE beneficiaries(id INTEGER PRIMARY KEY,access_token TEXT,access_granted INTEGER);
    INSERT INTO users VALUES(1,'2026-01-01T00:00:00.000Z');
    INSERT INTO dead_switch_config VALUES(1,1,1);
    INSERT INTO vault_entries VALUES(1,'preserved-ciphertext');
    INSERT INTO beneficiaries VALUES(1,'preserved-token-hash',1);`);
  initNotificationSchema(db);
  return { directory, databasePath, db };
}

test('restore tool requires service-stopped acknowledgement and never creates a database', t => {
  const { directory } = fixture(t);
  const missing = path.join(directory, 'missing.db');
  const script = path.join(__dirname, '../scripts/email-restore-safety.js');
  assert.equal(spawnSync(process.execPath, [script, missing], { encoding: 'utf8' }).status, 2);
  assert.equal(spawnSync(process.execPath, [script, '--service-stopped', missing], { encoding: 'utf8' }).status, 1);
  assert.equal(fs.existsSync(missing), false);
  assert.throws(() => quarantine('relative.db'));
});

test('restore quarantine revokes mail credentials and pending work while preserving vault state and history', t => {
  const { db, databasePath } = fixture(t);
  db.exec(`INSERT INTO notification_settings(user_id,recipient,verified_at,reply_enabled,verify_hash,verify_nonce,verify_expires_at)
      VALUES(1,'test@example.invalid','2026-01-01T00:00:00Z',1,'hash','nonce','2099-01-01T00:00:00Z');
    INSERT INTO notification_cycles VALUES('cycle',1,'2026-01-01T00:00:00Z','2026-01-31T00:00:00Z','2026-02-07T00:00:00Z','open','2026-01-01T00:00:00Z','test');
    INSERT INTO checkin_recovery_codes VALUES(1,1,'batch','unused-hash','2026-01-01T00:00:00Z',NULL,NULL);
    INSERT INTO checkin_recovery_codes VALUES(2,1,'batch','used-hash','2026-01-01T00:00:00Z','2026-01-02T00:00:00Z',NULL);`);
  const statuses = ['queued','retried','sending','failed','uncertain','sent_to_server','delivered','dead_letter'];
  const insertOutbox = db.prepare(`INSERT INTO notification_outbox(event_type,user_id,cycle_id,idempotency_key,schedule_at,status,message_id,created_at,updated_at)
    VALUES('test',1,'cycle',?,'2026-01-01T00:00:00Z',?,?,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')`);
  for (const status of statuses) insertOutbox.run(status,status,`<${status}@test.invalid>`);
  db.exec(`INSERT INTO checkin_challenges VALUES('challenge','challenge-hash',1,'cycle',1,'<queued@test.invalid>',
    '2026-01-01T00:00:00Z','2026-01-02T00:00:00Z',NULL,NULL,NULL,1);`);
  const result = quarantine(databasePath);
  assert.equal(result.outbox,5);
  assert.equal(result.challenges,1);
  assert.equal(result.recoveryCodes,1);
  const settings = db.prepare('SELECT * FROM notification_settings').get();
  assert.equal(settings.reply_enabled,0);
  assert.equal(settings.verified_at,null);
  assert.equal(settings.verify_hash,null);
  assert.equal(settings.verify_nonce,null);
  assert.equal(settings.config_status,'restore_review');
  for (const status of statuses) assert.equal(db.prepare('SELECT status FROM notification_outbox WHERE idempotency_key=?').get(status).status,
    ['sent_to_server','delivered','dead_letter'].includes(status) ? status : 'cancelled');
  assert.equal(db.prepare('SELECT status FROM notification_cycles').get().status,'superseded');
  assert.ok(db.prepare('SELECT revoked_at FROM checkin_recovery_codes WHERE id=1').get().revoked_at);
  assert.equal(db.prepare('SELECT revoked_at FROM checkin_recovery_codes WHERE id=2').get().revoked_at,null);
  assert.equal(db.prepare('SELECT fields_encrypted FROM vault_entries').get().fields_encrypted,'preserved-ciphertext');
  assert.deepEqual(db.prepare('SELECT * FROM beneficiaries').get(),{id:1,access_token:'preserved-token-hash',access_granted:1});
  assert.equal(db.prepare('SELECT last_check_in FROM users').get().last_check_in,'2026-01-01T00:00:00.000Z');
  assert.equal(db.prepare('SELECT switch_triggered FROM dead_switch_config').get().switch_triggered,1);
  const repeat = quarantine(databasePath);
  assert.equal(repeat.outbox,0);
  assert.equal(repeat.recoveryCodes,0);
  assert.equal(repeat.challenges,0);
});

test('incomplete schema fails before any mutation; pre-email database is an explicit no-op', t => {
  const { directory } = fixture(t);
  const oldPath = path.join(directory,'old.db');
  const old = new Database(oldPath);
  old.exec('CREATE TABLE users(id INTEGER PRIMARY KEY)');
  old.close();
  assert.deepEqual(quarantine(oldPath),{result:'no_email_schema',changed:false});
  const partialPath = path.join(directory,'partial.db');
  const partial = new Database(partialPath);
  partial.exec('CREATE TABLE notification_settings(reply_enabled INTEGER); INSERT INTO notification_settings VALUES(1)');
  assert.throws(() => quarantine(partialPath),/Incomplete email schema/);
  assert.equal(partial.prepare('SELECT reply_enabled FROM notification_settings').get().reply_enabled,1);
  partial.close();
});
