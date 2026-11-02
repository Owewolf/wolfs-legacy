#!/usr/bin/env node
'use strict';

// Run under an external single-runner lock, independently of sleeping web
// processes. Never import server/index.js: it starts an HTTP server and timers.
const path = require('node:path');

async function runBackgroundJobs(dependencies = {}) {
  const loadEnvironment = dependencies.loadEnvironment || (() => require('dotenv').config({
    path: path.join(__dirname, '..', '.env'), debug: false
  }));
  loadEnvironment();
  (dependencies.ensureSecrets || require('../server/config').ensureSecrets)();
  const db = (dependencies.getDb || require('../server/db').getDb)();
  const env = dependencies.env || process.env;
  let worker;
  try {
    const createService = dependencies.createNotificationService ||
      require('../server/notifications/service').createNotificationService;
    createService({ db, env }).releaseDue();
    const syncUser = dependencies.syncUser || require('../server/homebank-service').syncUser;
    const users = db.prepare('SELECT user_id FROM homebank_snapshots').all();
    for (const { user_id } of users) await syncUser(user_id);
    const createWorker = dependencies.createNotificationWorker ||
      require('../server/notifications/worker').createNotificationWorker;
    worker = createWorker({ db, env });
    worker.recoverInterrupted();
    // This explicit runner still operates when the web-process flag is false.
    // The worker itself respects NOTIFICATIONS_ENABLED for SMTP/IMAP activity.
    await worker.tick();
    return { homebank_users: users.length };
  } finally {
    try { await worker?.stop(); }
    finally { db.close(); }
  }
}

async function main() {
  try {
    await runBackgroundJobs();
    process.stdout.write('Background jobs completed.\n');
    return 0;
  } catch {
    // Raw filesystem, SQL or transport errors can contain private information.
    process.stderr.write('Background jobs failed. Check private service configuration and job status.\n');
    return 1;
  }
}

if (require.main === module) main().then(code => { process.exitCode = code; });
module.exports = { runBackgroundJobs, main };
