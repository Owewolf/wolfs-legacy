'use strict';
const Database = require('better-sqlite3');
const { initNotificationSchema } = require('../../server/notifications/schema');
const { createNotificationService, derivedCode } = require('../../server/notifications/service');

const DAY = 86400000;
const START = '2026-01-01T08:15:00.000Z';

function createFixture(t, { filename = ':memory:', verified = true, replyEnabled = true } = {}) {
  const db = new Database(filename);
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  t.after(() => { if (db.open) db.close(); });
  db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY,email TEXT,name TEXT,last_check_in TEXT);
    CREATE TABLE dead_switch_config (id INTEGER PRIMARY KEY,user_id INTEGER UNIQUE,
      check_in_interval_days INTEGER,grace_period_days INTEGER,is_active INTEGER,
      switch_triggered INTEGER DEFAULT 0,switch_triggered_at TEXT);
    CREATE TABLE beneficiaries (id INTEGER PRIMARY KEY,user_id INTEGER,name TEXT,email TEXT,access_token TEXT,
      access_granted INTEGER DEFAULT 0,access_granted_at TEXT,emergency_access_requested INTEGER DEFAULT 0,
      emergency_access_requested_at TEXT,emergency_waiting_days INTEGER DEFAULT 7);
    CREATE TABLE audit_log (id INTEGER PRIMARY KEY,user_id INTEGER,action TEXT,target_type TEXT,detail TEXT,created_at TEXT);
    INSERT INTO users VALUES (1,'owner@example.test','Fixture owner','${START}');
    INSERT INTO users VALUES (2,'other@example.test','Other owner','${START}');
    INSERT INTO dead_switch_config VALUES (1,1,30,7,1,0,NULL);
    INSERT INTO dead_switch_config VALUES (2,2,30,7,0,0,NULL);
    INSERT INTO beneficiaries VALUES (1,1,'Fixture beneficiary','beneficiary@example.test','preserved-token-hash',0,NULL,1,'2026-01-01 08:15:00',7);
    INSERT INTO beneficiaries VALUES (2,1,'Granted beneficiary','granted@example.test','another-token-hash',1,'2025-12-01 08:15:00',0,NULL,7);`);
  initNotificationSchema(db);
  db.prepare('INSERT INTO notification_settings (user_id,recipient,verified_at,reply_enabled) VALUES (1,?,?,?)')
    .run('owner@example.test', verified ? START : null, replyEnabled ? 1 : 0);
  const env = {
    NOTIFICATIONS_ENABLED: 'true', NOTIFICATION_SECRET: 'ab'.repeat(32),
    CHECKIN_REPLY_MAILBOX: 'replies@example.test', SMTP_FROM: 'notifications@example.test',
    CHECKIN_TRUSTED_AUTHSERV_IDS: 'mx.example.test', NOTIFICATION_TIMEZONE: 'Africa/Johannesburg'
  };
  let instant = START;
  const now = () => new Date(instant);
  const service = createNotificationService({ db, env, now });
  return {
    db, env, now, service,
    setNow(value) { instant = new Date(value).toISOString(); },
    setDay(day, extra = 0) { instant = new Date(Date.parse(START) + day * DAY + extra).toISOString(); },
    get instant() { return instant; },
    user() { return db.prepare('SELECT * FROM users WHERE id=1').get(); },
    config() { return db.prepare('SELECT * FROM dead_switch_config WHERE user_id=1').get(); },
    jobs(type = 'reminder') { return db.prepare('SELECT * FROM notification_outbox WHERE event_type=? ORDER BY schedule_at,id').all(type); },
    beneficiaries() { return db.prepare('SELECT * FROM beneficiaries ORDER BY id').all(); },
    issueReminder(index = 0) {
      service.reconcile();
      const job = db.prepare("SELECT * FROM notification_outbox WHERE event_type='reminder' AND status='queued' ORDER BY schedule_at,id").all()[index];
      if (!job) throw new Error('Fixture reminder missing');
      instant = job.schedule_at;
      job.message_id = `<fixture-reminder-${job.id}@example.test>`;
      db.prepare('UPDATE notification_outbox SET message_id=? WHERE id=?').run(job.message_id, job.id);
      const payload = service.prepareReminder(job);
      const challenge = db.prepare('SELECT * FROM checkin_challenges WHERE outbox_id=?').get(job.id);
      return { job, payload, challenge, value: derivedCode(env, 'challenge', challenge.id) };
    }
  };
}

function rawReply({ challenge, thread, messageId = '<reply-1@example.test>', from = 'owner@example.test',
  to = 'replies@example.test', subject = 'Re: Wolf check-in', body, extraHeaders = [] } = {}) {
  return [
    `From: Fixture owner <${from}>`, `To: ${to}`, `Subject: ${subject}`,
    `Message-ID: ${messageId}`, ...(thread ? [`In-Reply-To: ${thread}`, `References: ${thread}`] : []),
    'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8',
    'Authentication-Results: mx.example.test; dmarc=pass; dkim=pass; spf=pass',
    ...extraHeaders, '', body ?? `CONFIRM ${challenge}`,
  ].join('\r\n');
}

module.exports = { createFixture, rawReply, START, DAY };
