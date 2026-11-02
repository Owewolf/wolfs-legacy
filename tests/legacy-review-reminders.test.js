'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFixture } = require('./helpers/email-fixture');
const { createNotificationWorker } = require('../server/notifications/worker');
const { queueReviewReminders, prepareReviewReminder } = require('../server/legacy-review-notifications');

function fixture(t) {
  const f = createFixture(t);
  f.db.exec(`CREATE TABLE legacy_contents (
    id TEXT PRIMARY KEY,user_id INTEGER,status TEXT,review_enabled INTEGER,
    next_review_at TEXT,review_snoozed_until TEXT,last_reviewed_at TEXT,payload_encrypted TEXT);
    INSERT INTO legacy_contents VALUES ('private-letter',1,'draft',1,'2025-12-31T08:00:00.000Z',NULL,NULL,'confidential letter body');`);
  f.service.reconcile();
  return f;
}

test('due review jobs persist one logical reminder per schedule without check-in or access changes', t => {
  const f = fixture(t);
  const before = { user: f.user(), config: f.config(), beneficiaries: f.beneficiaries(), reminders: f.jobs() };
  assert.equal(queueReviewReminders({ db: f.db, service: f.service, now: f.now }), 1);
  assert.equal(queueReviewReminders({ db: f.db, service: f.service, now: f.now }), 0);
  f.setDay(1);
  assert.equal(queueReviewReminders({ db: f.db, service: f.service, now: f.now }), 0);
  assert.equal(f.jobs('legacy_review_due').length, 1);
  const job = f.jobs('legacy_review_due')[0];
  assert.equal(job.cycle_id, null);
  assert.equal(job.reminder_number, null);
  assert.ok(!job.data_json.includes('confidential letter body'));
  assert.deepEqual({ user: f.user(), config: f.config(), beneficiaries: f.beneficiaries(), reminders: f.jobs() }, before);
});

test('reviewed, rescheduled, snoozed, archived and disabled items invalidate old review jobs', async t => {
  for (const change of [
    "last_reviewed_at='2026-01-01T08:15:00.000Z'",
    "next_review_at='2027-01-01T08:15:00.000Z'",
    "review_snoozed_until='2026-02-01T08:15:00.000Z'",
    "status='archived'",
    'review_enabled=0'
  ]) await t.test(change, tt => {
    const f = fixture(tt);
    queueReviewReminders({ db: f.db, service: f.service, now: f.now });
    const job = f.jobs('legacy_review_due')[0];
    assert.deepEqual(prepareReviewReminder(f.db, job, f.instant), { nextReviewAt: '2025-12-31T08:00:00.000Z' });
    f.db.exec(`UPDATE legacy_contents SET ${change}`);
    assert.equal(prepareReviewReminder(f.db, job, f.instant), null);
    assert.equal(queueReviewReminders({ db: f.db, service: f.service, now: f.now }), change.startsWith('last_reviewed') ? 1 : 0);
  });
});

test('snooze creates one new reminder only after the snooze expires; unverified owners wait', t => {
  const f = fixture(t);
  f.db.prepare('UPDATE notification_settings SET verified_at=NULL').run();
  assert.equal(queueReviewReminders({ db: f.db, service: f.service, now: f.now }), 0);
  f.db.prepare('UPDATE notification_settings SET verified_at=?').run(f.instant);
  queueReviewReminders({ db: f.db, service: f.service, now: f.now });
  f.db.exec("UPDATE legacy_contents SET review_snoozed_until='2026-01-03T08:15:00.000Z'");
  assert.equal(queueReviewReminders({ db: f.db, service: f.service, now: f.now }), 0);
  f.setDay(2);
  assert.equal(queueReviewReminders({ db: f.db, service: f.service, now: f.now }), 1);
  assert.equal(queueReviewReminders({ db: f.db, service: f.service, now: f.now }), 0);
});

test('worker sends generic reviews and cancels stale ones while retaining five separate reminders', async t => {
  const f = fixture(t), messages = [];
  const instance = createNotificationWorker({ db: f.db, env: f.env, now: f.now,
    smtp: { async sendMail(message) { messages.push(message); return { status: 'sent_to_server', acceptedCount: 1, rejectedCount: 0 }; } },
    imap: { async poll() {} } });
  t.after(() => instance.stop());
  await instance.tick();
  assert.equal(messages.length, 1);
  assert.equal(messages[0].to, 'owner@example.test');
  assert.match(messages[0].subject, /Information review due/);
  assert.ok(!JSON.stringify(messages).includes('confidential letter body'));
  assert.ok(!JSON.stringify(messages).includes('private-letter'));
  assert.equal(f.jobs().length, 5);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM checkin_challenges').get().n, 0);
  f.db.exec("UPDATE legacy_contents SET next_review_at='2026-01-01T08:00:00.000Z'");
  queueReviewReminders({ db: f.db, service: f.service, now: f.now });
  f.db.exec("UPDATE legacy_contents SET status='archived'");
  await instance.tick();
  assert.equal(messages.length, 1);
  assert.equal(f.jobs('legacy_review_due')[1].status, 'cancelled');
  assert.equal(f.user().last_check_in, '2026-01-01T08:15:00.000Z');
});
