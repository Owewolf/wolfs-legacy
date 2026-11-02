'use strict';

// Only mocked entrypoints and synthetic in-memory databases are used. Never
// initialize the application's configured database, keys, network or workers.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createFixture } = require('./helpers/email-fixture');
const { createNotificationService } = require('../server/notifications/service');
const { createNotificationWorker } = require('../server/notifications/worker');
const { runBackgroundJobs } = require('../scripts/run-background-jobs');

const root = path.resolve(__dirname, '..');

function webEntrypoint(env = {}) {
  const calls = [], timers = [], handlers = new Map(), signals = [];
  const db = {};
  const app = {
    use() {}, set() {},
    get(route, handler) { handlers.set(route, handler); },
    listen(port, host, ready) { calls.push('listen'); ready(); }
  };
  const express = Object.assign(() => app, { json() {}, static() {} });
  const worker = { start() { calls.push('mail.start'); }, stop() { calls.push('mail.stop'); } };
  const modules = {
    dotenv: { config() { calls.push('environment'); } },
    './config': { ensureSecrets() { calls.push('secrets'); } },
    express, helmet() {}, 'express-rate-limit'() {}, path,
    './db': { getDb() { calls.push('database'); return db; } },
    './logger': { info() {}, error() {}, requestLogger() {} },
    './middleware/auth': { authenticateToken() {} },
    './beneficiary-final-wishes': {
      backfillBeneficiaryFinalWishes(actual) { assert.equal(actual, db); calls.push('backfill'); return { created: 0 }; }
    },
    './notifications/service': {
      createNotificationService() { return { releaseDue() { calls.push('release'); } }; }
    },
    './homebank-service': { startWatcher() { calls.push('homebank.watch'); } },
    './notifications/worker': {
      createNotificationWorker() { calls.push('mail.construct'); return worker; }
    }
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'server/index.js'), 'utf8'), {
    __dirname: path.join(root, 'server'),
    process: { env, once(signal, callback) { signals.push({ signal, callback }); }, exit() {} },
    setInterval(callback, milliseconds) { timers.push({ callback, milliseconds }); },
    require(name) {
      if (name.startsWith('./routes/')) return { ownerRouter() {}, beneficiaryRouter() {} };
      assert.ok(Object.hasOwn(modules, name), `Unexpected entrypoint import: ${name}`);
      return modules[name];
    }
  }, { filename: 'isolated-web-entrypoint.js' });
  return { calls, timers, handlers, signals };
}

for (const flag of [undefined, 'true']) {
  test(`web background jobs retain existing startup and timer behavior when flag is ${String(flag)}`, () => {
    const env = flag === undefined ? {} : { BACKGROUND_JOBS_ENABLED: flag };
    const { calls, timers, signals } = webEntrypoint(env);
    assert.equal(calls.filter(call => call === 'release').length, 1);
    assert.ok(calls.includes('homebank.watch'));
    assert.ok(calls.includes('mail.start'));
    assert.equal(timers.length, 1);
    assert.equal(timers[0].milliseconds, 60 * 60 * 1000);
    timers[0].callback();
    assert.equal(calls.filter(call => call === 'release').length, 2);
    assert.equal(signals.length, 1);
    assert.equal(signals[0].signal, 'SIGTERM');
    signals[0].callback();
    assert.ok(calls.includes('mail.stop'));
  });
}

test('a sleeping web process can serve its API without scheduling, releasing or recovering mail', () => {
  const { calls, timers, handlers, signals } = webEntrypoint({ BACKGROUND_JOBS_ENABLED: 'false' });
  assert.ok(calls.includes('listen'));
  assert.ok(calls.includes('backfill'), 'Private beneficiary draft initialization remains available');
  assert.ok(handlers.has('/health'));
  assert.deepEqual(timers, []);
  assert.deepEqual(signals, []);
  assert.ok(!calls.includes('release'));
  assert.ok(!calls.includes('homebank.watch'));
  assert.ok(!calls.includes('mail.construct'), 'No mail worker exists to recover another process’s pending send');
});

function mockedJobs() {
  const calls = [];
  const db = {
    open: true,
    prepare(sql) {
      assert.equal(sql, 'SELECT user_id FROM homebank_snapshots');
      return { all: () => [{ user_id: 11 }, { user_id: 22 }] };
    },
    close() { this.open = false; calls.push('close'); }
  };
  const worker = {
    recoverInterrupted() { calls.push('recover'); },
    async tick() { calls.push('tick'); },
    stop() { calls.push('stop'); }
  };
  const dependencies = {
    env: { BACKGROUND_JOBS_ENABLED: 'false' },
    loadEnvironment() { calls.push('environment'); },
    ensureSecrets() { calls.push('secrets'); },
    getDb() { calls.push('database'); return db; },
    createNotificationService({ db: actual }) {
      assert.equal(actual, db);
      return { releaseDue() { calls.push('release'); } };
    },
    async syncUser(id) { calls.push(`sync:${id}`); },
    createNotificationWorker({ db: actual }) { assert.equal(actual, db); return worker; }
  };
  return { calls, db, worker, dependencies };
}

test('the explicit runner awaits synchronization and durable mail work before closing SQLite', async () => {
  const fixture = mockedJobs();
  let finishTick, tickStarted;
  const started = new Promise(resolve => { tickStarted = resolve; });
  const pending = new Promise(resolve => { finishTick = resolve; });
  fixture.worker.tick = async () => {
    fixture.calls.push('tick'); tickStarted();
    await pending;
    assert.equal(fixture.db.open, true);
    fixture.calls.push('durable-mail-result');
  };
  const run = runBackgroundJobs(fixture.dependencies);
  await started;
  assert.equal(fixture.db.open, true);
  assert.ok(!fixture.calls.includes('stop'));
  finishTick();
  assert.deepEqual(await run, { homebank_users: 2 });
  assert.deepEqual(fixture.calls, ['environment', 'secrets', 'database', 'release',
    'sync:11', 'sync:22', 'recover', 'tick', 'durable-mail-result', 'stop', 'close']);
});

for (const failure of ['release', 'homebank', 'recovery', 'mail', 'stop']) {
  test(`the one-shot runner closes SQLite after a ${failure} failure`, async () => {
    const fixture = mockedJobs();
    const failed = () => { throw new Error('Synthetic job failure'); };
    if (failure === 'release') fixture.dependencies.createNotificationService = () => ({ releaseDue: failed });
    if (failure === 'homebank') fixture.dependencies.syncUser = failed;
    if (failure === 'recovery') fixture.worker.recoverInterrupted = failed;
    if (failure === 'mail') fixture.worker.tick = failed;
    if (failure === 'stop') fixture.worker.stop = failed;
    await assert.rejects(runBackgroundJobs(fixture.dependencies), /Synthetic job failure/);
    assert.equal(fixture.db.open, false);
    assert.equal(fixture.calls.at(-1), 'close');
    if (['recovery', 'mail'].includes(failure)) assert.ok(fixture.calls.includes('stop'));
  });
}

test('disabled email transport still releases due access, syncs HomeBank and recovers interrupted sends durably', async t => {
  const fixture = createFixture(t);
  fixture.env.NOTIFICATIONS_ENABLED = 'false';
  fixture.env.BACKGROUND_JOBS_ENABLED = 'false';
  fixture.setDay(38);
  fixture.db.exec('CREATE TABLE homebank_snapshots (user_id INTEGER PRIMARY KEY); INSERT INTO homebank_snapshots VALUES (1)');
  const interrupted = fixture.service.queue('email_test', 1);
  fixture.db.prepare("UPDATE notification_outbox SET status='sending',attempts=1 WHERE id=?").run(interrupted);
  const synced = [];
  let saved;
  const result = await runBackgroundJobs({
    loadEnvironment() {}, ensureSecrets() {}, getDb: () => fixture.db, env: fixture.env,
    createNotificationService: options => createNotificationService({ ...options, now: fixture.now }),
    async syncUser(id) { synced.push(id); },
    createNotificationWorker(options) {
      const worker = createNotificationWorker({ ...options, now: fixture.now,
        smtp: { sendMail() { assert.fail('Disabled transport must not send mail'); } },
        imap: { poll() { assert.fail('Disabled transport must not open a mailbox'); } } });
      return { ...worker, stop() {
        saved = {
          released: fixture.config().switch_triggered,
          beneficiaries: fixture.beneficiaries(),
          interrupted: fixture.db.prepare('SELECT status FROM notification_outbox WHERE id=?').get(interrupted).status,
          releaseMail: fixture.jobs('deadswitch_released').map(job => job.status)
        };
        worker.stop();
      } };
    }
  });
  assert.deepEqual(result, { homebank_users: 1 });
  assert.deepEqual(synced, [1]);
  assert.equal(saved.released, 1);
  assert.ok(saved.beneficiaries.every(beneficiary => beneficiary.access_granted === 1));
  assert.equal(saved.interrupted, 'uncertain');
  assert.deepEqual(saved.releaseMail, ['queued']);
  assert.equal(fixture.db.open, false);
});

test('the CLI loads its own release environment without importing or starting the HTTP application', async () => {
  const fixture = mockedJobs();
  const output = [], errors = [], loaded = [];
  const isolatedModule = { exports: {} };
  const source = fs.readFileSync(path.join(root, 'scripts/run-background-jobs.js'), 'utf8');
  const modules = {
    'node:path': path,
    dotenv: { config(options) { loaded.push(options); } },
    '../server/config': { ensureSecrets: fixture.dependencies.ensureSecrets },
    '../server/db': { getDb: fixture.dependencies.getDb },
    '../server/notifications/service': { createNotificationService: fixture.dependencies.createNotificationService },
    '../server/homebank-service': { syncUser: fixture.dependencies.syncUser },
    '../server/notifications/worker': { createNotificationWorker: fixture.dependencies.createNotificationWorker }
  };
  vm.runInNewContext(source, {
    __dirname: path.join(root, 'scripts'), module: isolatedModule,
    process: { env: fixture.dependencies.env,
      stdout: { write: value => output.push(value) }, stderr: { write: value => errors.push(value) } },
    require(name) { assert.ok(Object.hasOwn(modules, name), `Unexpected CLI import: ${name}`); return modules[name]; }
  }, { filename: 'isolated-background-runner.js' });
  assert.deepEqual(fixture.calls, [], 'Importing the runner does not initialize keys, database or jobs');
  assert.equal(await isolatedModule.exports.main(), 0);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].path, path.join(root, '.env'));
  assert.equal(fixture.db.open, false);
  assert.deepEqual(output, ['Background jobs completed.\n']);
  assert.deepEqual(errors, []);
});
