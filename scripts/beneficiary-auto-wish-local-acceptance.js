#!/usr/bin/env node
'use strict';

// Real-entrypoint acceptance with synthetic records only. IPv6 loopback avoids
// the separately running IPv4 frontend/proxy on port 4444. Nothing is deployed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

async function browserAcceptance(credentials) {
  const checks = [];
  const check = (value, label) => { if (!value) throw new Error(label); checks.push(label); };
  const pause = () => new Promise(resolve => setTimeout(resolve, 30));
  const until = async (predicate, label) => { for (let n = 0; n < 200; n++) { if (predicate()) return; await pause(); } throw new Error('Timed out: ' + label); };
  const route = async (hash, selector) => { location.hash = hash; await until(() => document.querySelector(selector), hash); await pause(); };
  const recipientRequest = async (token, suffix = '') => {
    const response = await fetch('/api/beneficiary-access/legacy' + suffix, { cache: 'no-store', headers: { Authorization: 'Bearer ' + token } });
    return { status: response.status, data: await response.json(), cache: response.headers.get('cache-control') };
  };
  await until(() => document.querySelector('#login-form'), 'existing owner sign-in');
  document.querySelector('#login-email').value = credentials.email;
  document.querySelector('#login-password').value = credentials.password;
  document.querySelector('#login-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await until(() => document.querySelector('.vault-grid'), 'authenticated dashboard');
  check(Boolean(API.token && state.user), 'existing synthetic owner signs in through the real authentication route');
  await API.createEntry({ section: 'secure_notes', title: 'Unreleased synthetic private vault record', fields: { content: 'Synthetic vault content' } });
  const originalAdd = API.addBeneficiary;
  let created;
  API.addBeneficiary = async body => { created = await originalAdd(body); return created; };
  await route('beneficiaries', '#add-ben-btn');
  document.querySelector('#add-ben-btn').click();
  const form = document.querySelector('#add-ben-form');
  form.elements.name.value = 'Synthetic Beneficiary A';
  form.elements.email.value = 'synthetic-beneficiary-a@example.test';
  form.elements.relationship.value = 'Child';
  form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await until(() => created && !document.querySelector('#add-ben-form') && document.querySelector('[data-legacy-beneficiary="' + created.id + '"]'), 'beneficiary creation');
  API.addBeneficiary = originalAdd;
  check(Boolean(created.final_wish_id && created.accessToken), 'real beneficiary creation returns its dedicated Final Wish and token');
  const other = await API.addBeneficiary({ name: 'Synthetic Beneficiary B', email: 'synthetic-beneficiary-b@example.test', relationship: 'Child' });
  const panel = document.querySelector('[data-legacy-beneficiary="' + created.id + '"]');
  panel.open = true;
  await until(() => panel.querySelector('[data-locked-beneficiary="' + created.id + '"]'), 'owner beneficiary summary');
  check(Boolean(panel.querySelector('a[href="#section/final_wishes/' + created.final_wish_id + '"]')), 'owner beneficiary summary links to the same automatically created wish');
  await route('section/final_wishes/' + created.final_wish_id, '[data-legacy-action="edit"]');
  check(!document.querySelector('[data-legacy-action="delete"]'), 'active automatic wish has no ordinary Delete action');
  document.querySelector('[data-legacy-action="edit"]').click();
  await until(() => document.querySelector('#legacy-editor'), 'automatic wish editor');
  const editor = document.querySelector('#legacy-editor');
  check(Boolean(editor.querySelector('[data-locked-beneficiary="' + created.id + '"]')) && !editor.querySelector('#legacy-recipient-search,[data-add-recipient],[data-remove-recipient]'), 'actual owner editor locks the dedicated recipient and has no general recipient picker');
  editor.elements.body_markdown.value = 'Synthetic message edited through the real owner UI.';
  editor.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await until(() => !document.querySelector('#legacy-editor') && document.querySelector('.legacy-markdown')?.textContent.includes('Synthetic message edited'), 'saved owner message');
  const ownerWish = await API.request('GET', '/final-wishes/legacy/' + created.final_wish_id);
  check(ownerWish.id === created.final_wish_id && ownerWish.beneficiary_ids.length === 1 && ownerWish.beneficiary_ids[0] === created.id, 'actual owner edit updates the same exclusively linked record');
  const crafted = await fetch('/api/final-wishes/legacy/' + created.final_wish_id, { method: 'PATCH', headers: { Authorization: 'Bearer ' + API.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ beneficiary_ids: [other.id] }) });
  check(crafted.status >= 400 && crafted.status < 500, 'actual server rejects a crafted automatic-recipient reassignment');
  await API.request('POST', '/final-wishes/legacy', { type: 'letter', title: 'Unreleased synthetic manual wish', body_markdown: 'Synthetic private manual content', status: 'draft', release_policy: 'owner_only', beneficiary_ids: [created.id, other.id] });
  let personal = await recipientRequest(created.accessToken);
  check(personal.status === 200 && personal.data.length === 1 && personal.data[0].id === created.final_wish_id && personal.data[0].access_scope === 'personal_final_wish', 'valid ungranted token lists only its own personal wish through the real API');
  check(personal.cache?.includes('no-store'), 'personal content uses private no-store responses');
  const detail = await recipientRequest(created.accessToken, '/' + created.final_wish_id);
  check(detail.status === 200 && detail.data.body_markdown === ownerWish.body_markdown, 'next real token read contains the owner edit');
  const cross = await recipientRequest(created.accessToken, '/' + other.final_wish_id);
  check(cross.status === 404, 'actual token API conceals the other beneficiary’s dedicated wish');
  const general = await API.accessVault(created.accessToken);
  check(general.status === 'no_access' && !general.entries?.length, 'real access API retains no_access and exposes no ordinary vault entries');
  await route('access', '#access-form');
  document.querySelector('#access-form').elements.token.value = created.accessToken;
  document.querySelector('#access-form [value="access"]').click();
  await until(() => document.querySelector('[data-recipient-content="' + created.final_wish_id + '"]'), 'personal token browser panel');
  check(document.querySelector('#access-result').textContent.includes('General vault access not yet granted') && !document.querySelector('.vault-readonly') && !document.querySelector('#access-result').textContent.includes('Unreleased synthetic'), 'real browser shows the personal wish while withholding the vault and manual draft');
  document.querySelector('[data-recipient-content="' + created.final_wish_id + '"]').click();
  await until(() => document.querySelector('#beneficiary-legacy-root').textContent.includes('Synthetic message edited'), 'personal token rendered message');
  document.querySelector('#access-form [value="emergency"]').click();
  await until(() => document.querySelector('#access-result').textContent.includes('Emergency access requested.') && document.querySelector('[data-recipient-content="' + created.final_wish_id + '"]'), 'real emergency request personal panel');
  const waiting = await API.accessVault(created.accessToken);
  check(waiting.status === 'waiting' && !waiting.entries?.length && !document.querySelector('.vault-readonly'), 'real emergency waiting status retains the personal wish without a vault grant');
  await route('beneficiaries', '[data-revoke="' + created.id + '"]');
  document.querySelector('[data-revoke="' + created.id + '"]').click();
  await until(() => document.querySelector('[data-restore-personal-wish="' + created.id + '"]'), 'owner explicit revocation');
  personal = await recipientRequest(created.accessToken);
  check(personal.status === 200 && personal.data.length === 0, 'actual owner revoke removes the personal entitlement');
  window.confirm = () => true;
  document.querySelector('[data-restore-personal-wish="' + created.id + '"]').click();
  await until(() => !document.querySelector('[data-restore-personal-wish="' + created.id + '"]'), 'owner explicit restoration');
  const restored = await API.accessVault(created.accessToken);
  personal = await recipientRequest(created.accessToken);
  check(restored.status !== 'granted' && personal.data.length === 1 && personal.data[0].id === created.final_wish_id, 'actual confirmed restoration restores only the personal wish');
  check(!Object.keys(localStorage).some(key => String(localStorage.getItem(key)).includes(created.accessToken)) && !location.href.includes(created.accessToken), 'beneficiary token stays out of browser storage and URL');
  check(document.documentElement.scrollWidth <= innerWidth + 1, 'actual desktop owner UI fits its viewport');
  return { ok: true, browser: 'Firefox', width: innerWidth, checks };
}

async function run() {
  const checkout = path.resolve(__dirname, '..');
  const output = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'wolfs-legacy-auto-wish-local-acceptance.json'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wolfs-auto-wish-real-'));
  fs.chmodSync(root, 0o700);
  let server;
  let browser;
  let logs = '';
  let browserLogs = '';
  const reportPath = path.join(root, 'browser-report.json');
  const runId = crypto.randomUUID();
  const origin = 'http://[::1]:4444';
  const credentials = { email: 'synthetic-owner@example.test', password: 'Synthetic-local-acceptance-2468', name: 'Synthetic Existing Owner' };
  try {
    for (const directory of ['server', 'public']) fs.cpSync(path.join(checkout, directory), path.join(root, directory), { recursive: true });
    fs.symlinkSync(path.join(checkout, 'node_modules'), path.join(root, 'node_modules'), 'dir');
    // Observation only: the disposable copy adds a same-origin result sink.
    const indexPath = path.join(root, 'server/index.js');
    fs.writeFileSync(indexPath, fs.readFileSync(indexPath, 'utf8').replace('// Health check', `app.post('/__local-acceptance-result', (req,res)=>{require('node:fs').writeFileSync(process.env.LOCAL_ACCEPTANCE_REPORT,JSON.stringify(req.body));res.json({ok:true});});\napp.get('/__local-acceptance-status',(req,res)=>res.json({run_id:process.env.LOCAL_ACCEPTANCE_RUN_ID}));\n// Health check`));
    const pagePath = path.join(root, 'public/index.html');
    fs.writeFileSync(pagePath, fs.readFileSync(pagePath, 'utf8').replace('</body>', '<script src="/__local-acceptance.js"></script></body>'));
    fs.writeFileSync(path.join(root, 'public/__local-acceptance.js'), `(${browserAcceptance.toString()})(${JSON.stringify(credentials)}).then(report=>fetch('/__local-acceptance-result',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(report)})).catch(error=>fetch('/__local-acceptance-result',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ok:false,error:error.message})}));`);
    const environment = { PATH: process.env.PATH, NODE_ENV: 'test', PORT: '4444', LISTEN_HOST: '::1', JWT_SECRET: crypto.randomBytes(32).toString('hex'), ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'), OTP_HASH_KEY: crypto.randomBytes(32).toString('hex'), AUTH_SMS_REQUIRED: 'false', ACCOUNT_APPROVAL_REQUIRED: 'true', COLLECTOR_SMS_ENABLED: 'false', SMS_ENABLED: 'false', NOTIFICATIONS_ENABLED: 'false', BACKGROUND_JOBS_ENABLED: 'false', DOCUMENT_STORAGE_ROOT: path.join(root, 'managed-documents'), LOCAL_ACCEPTANCE_REPORT: reportPath, LOCAL_ACCEPTANCE_RUN_ID: runId };
    server = spawn(process.execPath, [indexPath], { cwd: root, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stdout.on('data', chunk => { logs += String(chunk); });
    server.stderr.on('data', chunk => { logs += String(chunk); });
    let healthy = false;
    for (let n = 0; n < 150; n++) {
      if (server.exitCode !== null) throw new Error('Disposable IPv6 application exited before acceptance');
      try {
        const health = await fetch(origin + '/health', { signal: AbortSignal.timeout(500) });
        const identity = await fetch(origin + '/__local-acceptance-status', { signal: AbortSignal.timeout(500) });
        healthy = health.ok && identity.ok && (await identity.json()).run_id === runId;
        if (healthy) break;
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    assert.ok(healthy, 'disposable real entrypoint became healthy on IPv6 loopback port 4444');
    const db = new Database(path.join(root, 'data/vault.db'));
    const owner = db.prepare('INSERT INTO users(email,password_hash,name) VALUES(?,?,?)').run(credentials.email, bcrypt.hashSync(credentials.password, 4), credentials.name);
    db.prepare('INSERT INTO dead_switch_config(user_id) VALUES(?)').run(owner.lastInsertRowid);
    db.close();
    const firefox = [process.env.FIREFOX_BIN, '/usr/bin/firefox', '/usr/bin/firefox-esr'].filter(Boolean).find(candidate => { try { fs.accessSync(candidate, fs.constants.X_OK); return true; } catch { return false; } });
    assert.ok(firefox, 'Firefox must be installed for actual-entrypoint acceptance');
    const profile = path.join(root, 'firefox-profile'); fs.mkdirSync(profile, { mode: 0o700 });
    fs.writeFileSync(path.join(profile, 'user.js'), 'user_pref("network.proxy.type", 0);\nuser_pref("datareporting.healthreport.uploadEnabled", false);\nuser_pref("toolkit.telemetry.enabled", false);\n');
    browser = spawn(firefox, ['--headless', '--no-remote', '--profile', profile, '--width', '1440', '--height', '1100', origin + '/#login'], { env: { PATH: process.env.PATH, HOME: process.env.HOME, MOZ_CRASHREPORTER_DISABLE: '1' }, stdio: ['ignore', 'ignore', 'pipe'] });
    browser.stderr.on('data', chunk => { browserLogs = (browserLogs + String(chunk)).slice(-2000); });
    for (let n = 0; n < 1200 && !fs.existsSync(reportPath); n++) { if (browser.exitCode !== null) throw new Error('Firefox exited before returning acceptance evidence'); await new Promise(resolve => setTimeout(resolve, 30)); }
    assert.ok(fs.existsSync(reportPath), 'real Firefox acceptance completed within 36 seconds');
    const browserReport = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    assert.equal(browserReport.ok, true, browserReport.error || 'real Firefox acceptance failed');
    const resultDb = new Database(path.join(root, 'data/vault.db'));
    const counts = { users: resultDb.prepare('SELECT COUNT(*) n FROM users').get().n, beneficiaries: resultDb.prepare('SELECT COUNT(*) n FROM beneficiaries').get().n, dedicated_wishes: resultDb.prepare('SELECT COUNT(*) n FROM legacy_beneficiary_auto_wishes').get().n, sms_attempts: resultDb.prepare('SELECT COUNT(*) n FROM sms_otp_challenges').get().n, notifications: resultDb.prepare('SELECT COUNT(*) n FROM notification_outbox').get().n };
    const plaintextCopies = resultDb.prepare("SELECT COUNT(*) n FROM vault_entries WHERE section='final_wishes'").get().n;
    resultDb.close();
    assert.equal(counts.sms_attempts, 0);
    assert.equal(counts.notifications, 0);
    assert.equal(plaintextCopies, 0);
    assert.equal(counts.dedicated_wishes, counts.beneficiaries);
    assert.ok(!/sms_otp_simulated_send|sms_otp_provider_response/.test(logs));
    const evidence = { ...browserReport, origin, actual_entrypoint: 'server/index.js (disposable source copy; observation endpoints only)', environment: 'synthetic existing owner and data; no repository secrets/data copied; background jobs and all SMS/mail transports disabled', counts, unrestricted_final_wish_copies: plaintextCopies, checked_at: new Date().toISOString() };
    fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
    process.stdout.write(JSON.stringify({ ok: true, checks: evidence.checks.length, origin, counts, evidence: output }) + '\n');
  } catch (error) {
    // Logs are intentionally withheld: the result contains only check labels.
    process.stderr.write('Local actual-entrypoint acceptance failed: ' + error.message + '\n');
    if (browserLogs.includes('Address already in use') || logs.includes('EADDRINUSE')) process.stderr.write('IPv6 loopback port 4444 is occupied; existing listeners were left untouched.\n');
    process.exitCode = 1;
  } finally {
    for (const child of [browser, server]) if (child && child.exitCode === null) { child.kill('SIGTERM'); await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 2000))]); }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

if (require.main === module) void run();
