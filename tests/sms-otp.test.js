'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { initSmsOtpSchema, createSmsOtpService } = require('../server/sms-otp');

function createDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE users (
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
  `);
  initSmsOtpSchema(db);
  db.prepare('INSERT INTO users(email,password_hash,name) VALUES(?,?,?)').run('owner@example.test', 'hash', 'Owner');
  return db;
}

test('enrollment verifies OTP and enables sms_2fa with recovery codes', async () => {
  const db = createDb();
  const sent = [];
  const svc = createSmsOtpService({
    db,
    env: { OTP_HASH_KEY: 'k'.repeat(32) },
    smsSender: { sendOtp: async payload => { sent.push(payload); } }
  });

  const started = await svc.startEnrollment({ userId: 1, phone: '+27821230001' });
  assert.equal(started.ok, true);
  assert.equal(sent.length, 1);

  const smsText = sent[0].message;
  const otpMatch = smsText.match(/(\d{6})/);
  assert.ok(otpMatch);
  const otp = otpMatch[1];

  const done = svc.completeEnrollment({
    userId: 1,
    challengeId: started.challenge.challenge_id,
    challengeToken: started.challenge.challenge_token,
    otp
  });
  assert.equal(done.ok, true);
  assert.equal(done.recovery_codes.length, 10);

  const user = db.prepare('SELECT sms_2fa_enabled,sms_2fa_phone_e164 FROM users WHERE id=1').get();
  assert.equal(user.sms_2fa_enabled, 1);
  assert.equal(user.sms_2fa_phone_e164, '+27821230001');

  db.close();
});

test('challenge locks after five bad attempts', async () => {
  const db = createDb();
  db.prepare('UPDATE users SET sms_2fa_enabled=1,sms_2fa_phone_e164=? WHERE id=1').run('+27821230002');
  const sent = [];
  const svc = createSmsOtpService({
    db,
    env: { OTP_HASH_KEY: 'k'.repeat(32) },
    smsSender: { sendOtp: async payload => { sent.push(payload); } }
  });

  const issued = await svc.issueLoginChallenge({ userId: 1, phone: '+27821230002' });
  assert.equal(issued.ok, true);

  for (let i = 0; i < 4; i += 1) {
    const r = svc.verifyLoginChallenge({
      challengeId: issued.challenge.challenge_id,
      challengeToken: issued.challenge.challenge_token,
      otp: '000000'
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'invalid_otp');
  }

  const fifth = svc.verifyLoginChallenge({
    challengeId: issued.challenge.challenge_id,
    challengeToken: issued.challenge.challenge_token,
    otp: '000000'
  });
  assert.equal(fifth.ok, false);
  assert.equal(fifth.reason, 'locked');

  db.close();
});

test('resend enforces cooldown and refreshes OTP', async () => {
  const db = createDb();
  const sent = [];
  let now = Date.parse('2026-01-01T00:00:00.000Z');
  const svc = createSmsOtpService({
    db,
    now: () => now,
    env: { OTP_HASH_KEY: 'k'.repeat(32) },
    smsSender: { sendOtp: async payload => { sent.push(payload); } }
  });

  const issued = await svc.startEnrollment({ userId: 1, phone: '+27821230003' });
  assert.equal(issued.ok, true);

  const early = await svc.resendChallenge({
    challengeId: issued.challenge.challenge_id,
    challengeToken: issued.challenge.challenge_token,
    purpose: 'enrollment',
    userId: 1
  });
  assert.equal(early.ok, false);
  assert.equal(early.reason, 'cooldown');

  now += 61 * 1000;
  const resent = await svc.resendChallenge({
    challengeId: issued.challenge.challenge_id,
    challengeToken: issued.challenge.challenge_token,
    purpose: 'enrollment',
    userId: 1
  });
  assert.equal(resent.ok, true);
  assert.equal(sent.length, 2);

  db.close();
});

test('recovery codes allow login challenge completion once', async () => {
  const db = createDb();
  const sent = [];
  const svc = createSmsOtpService({
    db,
    env: { OTP_HASH_KEY: 'k'.repeat(32) },
    smsSender: { sendOtp: async payload => { sent.push(payload); } }
  });

  const started = await svc.startEnrollment({ userId: 1, phone: '+27821230004' });
  const firstOtp = sent[0].message.match(/(\d{6})/)[1];
  const done = svc.completeEnrollment({
    userId: 1,
    challengeId: started.challenge.challenge_id,
    challengeToken: started.challenge.challenge_token,
    otp: firstOtp
  });
  const code = done.recovery_codes[0];

  const issued = await svc.issueLoginChallenge({ userId: 1, phone: '+27821230004' });
  const recovered = svc.verifyLoginChallenge({
    challengeId: issued.challenge.challenge_id,
    challengeToken: issued.challenge.challenge_token,
    recoveryCode: code
  });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.method, 'recovery_code');

  const issued2 = await svc.issueLoginChallenge({ userId: 1, phone: '+27821230004' });
  const reused = svc.verifyLoginChallenge({
    challengeId: issued2.challenge.challenge_id,
    challengeToken: issued2.challenge.challenge_token,
    recoveryCode: code
  });
  assert.equal(reused.ok, false);

  db.close();
});
