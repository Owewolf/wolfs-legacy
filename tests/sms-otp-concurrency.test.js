'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const Database = require('better-sqlite3');
const { initSmsOtpSchema, createSmsOtpService } = require('../server/sms-otp');

// Workers use only the named, freshly created synthetic fixture. They never
// import the application database, environment file, or SMS transport.
const workerSource = `
const { parentPort, workerData } = require('node:worker_threads');
const Database = require(workerData.databaseModule);
const { createSmsOtpService } = require(workerData.serviceModule);
const db = new Database(workerData.filename);
db.pragma('busy_timeout=5000');
const prepare = db.prepare.bind(db);
db.prepare = sql => {
  const statement = prepare(sql);
  if (sql === 'SELECT * FROM sms_otp_challenges WHERE id=?') {
    const get = statement.get.bind(statement);
    statement.get = (...args) => {
      const row = get(...args);
      // Widen the replay window that existed when the challenge was read
      // outside the write transaction. The fixed code holds its lock here.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
      return row;
    };
  }
  return statement;
};
const service = createSmsOtpService({ db, env: workerData.env, smsSender: { sendOtp: async () => {} } });
parentPort.once('message', () => {
  try {
    const result = service.verifyLoginChallenge(workerData.challenge);
    parentPort.postMessage({ok:result.ok,reason:result.reason,method:result.method,recovery_code_count:result.recovery_codes?.length || 0});
  } catch (error) { parentPort.postMessage({ error: error.message }); }
  finally { db.close(); parentPort.close(); }
});
parentPort.postMessage({ ready:true });
`;

async function raceChallenges(filename, env, challenges) {
  const workers = challenges.map(challenge => new Worker(workerSource, { eval: true, workerData: {
    filename, env, challenge,
    databaseModule: require.resolve('better-sqlite3'),
    serviceModule: require.resolve('../server/sms-otp')
  } }));
  try {
    await Promise.all(workers.map(worker => new Promise((resolve, reject) => {
      worker.once('error', reject);
      worker.once('message', message => message.ready ? resolve() : reject(new Error('Unexpected fixture startup')));
    })));
    const results = workers.map(worker => new Promise((resolve, reject) => {
      worker.once('error', reject);
      worker.once('message', resolve);
    }));
    workers.forEach(worker => worker.postMessage('verify'));
    return await Promise.all(results);
  } finally { await Promise.all(workers.map(worker => worker.terminate())); }
}

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wolfs-sms-concurrency-'));
  const filename = path.join(directory, 'synthetic.db');
  const db = new Database(filename);
  db.pragma('journal_mode=WAL');
  db.exec(`CREATE TABLE users (
    id INTEGER PRIMARY KEY, email TEXT, name TEXT, sms_2fa_enabled INTEGER,
    sms_2fa_phone_e164 TEXT, sms_2fa_enrolled_at TEXT
  ); INSERT INTO users VALUES(1,'synthetic@example.test','Synthetic owner',0,'+27821234567',NULL);`);
  initSmsOtpSchema(db);
  const env = { AUTH_SMS_REQUIRED: 'true', OTP_HASH_KEY: 'synthetic-concurrency-key' };
  const messages = [];
  const service = createSmsOtpService({ db, env, smsSender: { sendOtp: async payload => messages.push(payload) } });
  t.after(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { db, filename, env, service, messages };
}

test('separate SQLite connections cannot redeem one OTP twice or rotate first-enrollment codes twice', { timeout: 15000 }, async t => {
  const f = fixture(t);
  const issued = await f.service.issueLoginChallenge({ userId: 1, phone: '+27821234567' });
  const challenge = {
    challengeId: issued.challenge.challenge_id,
    challengeToken: issued.challenge.challenge_token,
    otp: f.messages[0].message.match(/\b(\d{6})\b/)[1]
  };
  const results = await raceChallenges(f.filename, f.env, [challenge, challenge]);
  assert.equal(results.filter(result => result.ok).length, 1, JSON.stringify(results));
  assert.equal(results.find(result => !result.ok).reason, 'already_used');
  assert.equal(results.find(result => result.ok).recovery_code_count, 10);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM sms_otp_recovery_codes').get().n, 10);
});

test('one recovery code cannot complete two challenges on separate SQLite connections', { timeout: 15000 }, async t => {
  const f = fixture(t);
  f.db.prepare('UPDATE users SET sms_2fa_enabled=1 WHERE id=1').run();
  const recovery = f.service.regenerateRecoveryCodes(1)[0];
  const first = await f.service.issueLoginChallenge({ userId: 1, phone: '+27821234567' });
  const second = await f.service.issueLoginChallenge({ userId: 1, phone: '+27821234567' });
  // Keep two outstanding historical challenges so recovery single-use is
  // independently exercised, even though new issuance revokes older ones.
  f.db.prepare('UPDATE sms_otp_challenges SET used_at=NULL WHERE id=?').run(first.challenge.challenge_id);
  const challenges = [first, second].map(issued => ({
    challengeId: issued.challenge.challenge_id,
    challengeToken: issued.challenge.challenge_token,
    recoveryCode: recovery
  }));
  const results = await raceChallenges(f.filename, f.env, challenges);
  assert.equal(results.filter(result => result.ok).length, 1, JSON.stringify(results));
  assert.equal(results.find(result => !result.ok).reason, 'invalid_recovery_code');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM sms_otp_recovery_codes WHERE consumed_at IS NOT NULL').get().n, 1);
});
