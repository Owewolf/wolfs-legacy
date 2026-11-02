'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { initSmsOtpSchema } = require('../server/sms-otp');

function baseDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      totp_secret TEXT,
      totp_enabled INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_check_in DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  return db;
}

test('sms otp schema migration keeps existing user rows unchanged', () => {
  const db = baseDb();
  db.prepare('INSERT INTO users(email,password_hash,name,totp_secret,totp_enabled) VALUES(?,?,?,?,?)')
    .run('owner@example.test', 'hash', 'Owner', 'legacy-secret', 1);

  const before = db.prepare('SELECT * FROM users WHERE id=1').get();

  db.exec('ALTER TABLE users ADD COLUMN sms_2fa_phone_e164 TEXT');
  db.exec('ALTER TABLE users ADD COLUMN sms_2fa_enabled INTEGER DEFAULT 0');
  db.exec('ALTER TABLE users ADD COLUMN sms_2fa_enrolled_at DATETIME');
  initSmsOtpSchema(db);

  const after = db.prepare('SELECT * FROM users WHERE id=1').get();
  assert.equal(after.email, before.email);
  assert.equal(after.password_hash, before.password_hash);
  assert.equal(after.name, before.name);
  assert.equal(after.totp_secret, before.totp_secret);
  assert.equal(after.totp_enabled, before.totp_enabled);
  assert.equal(after.sms_2fa_phone_e164, null);
  assert.equal(after.sms_2fa_enabled, 0);

  const smsTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sms_otp_challenges'").get();
  assert.ok(smsTable);

  db.close();
});
