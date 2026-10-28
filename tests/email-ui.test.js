'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

// This runs the real index.html, app router, styles and Notifications module in
// Firefox. Only API responses are mocked; no provider credentials are needed.
// Run: node --test tests/email-ui.test.js
// Set FIREFOX_BIN when Firefox is installed outside the usual Linux paths.
const firefox = [process.env.FIREFOX_BIN, '/usr/bin/firefox', '/usr/bin/firefox-esr']
  .filter(Boolean).find(candidate => { try { fs.accessSync(candidate, fs.constants.X_OK); return true; } catch { return false; } });
const publicRoot = path.join(__dirname, '..', 'public');

const apiFixture = `
const fixtureCalls = [];
let fixturePendingResolve;
const fixtureState = {
  settings: {recipient:'owner@example.com',verified_at:'2026-10-28T12:00:00Z',reply_enabled:true,timezone:'Africa/Johannesburg',reminder_clock:null},
  cycle:{expiry_at:'2026-11-01T12:00:00Z',status:'open'},
  health:[{channel:'imap',status:'degraded',failures:3,last_failure_at:'2026-10-28T12:00:00Z'}],
  outbox:[{event_type:'reminder',schedule_at:'2026-10-28T12:00:00Z',status:'uncertain',attempts:1,last_error:'<img src=x onerror=alert(1)>'}],
  transport_configured:true,reply_transport_configured:true
};
const API = {
  token:'fake-browser-test-session',
  async getMe(){return {name:'Test owner',email:'owner@example.com'};},
  setToken(value){this.token=value;},
  async request(method,route,body){
    fixtureCalls.push({method,route,body});
    if(route==='/notifications/acceptance/status')return {started:true,accepted_replies:1,acknowledgement_status:'sent_to_server'};
    if(method==='GET')return structuredClone(fixtureState);
    if(body?.password==='wrong-password')throw new Error('Current vault password is incorrect');
    if(route.endsWith('/verify/start')){
      fixtureState.settings.recipient=body.recipient;fixtureState.settings.verified_at=null;fixtureState.settings.reply_enabled=false;
      return {success:true};
    }
    if(route.endsWith('/verify/complete')){
      fixtureState.settings.verified_at='2026-10-28T12:00:00Z';fixtureState.settings.reply_enabled=true;
      return {success:true};
    }
    if(route.endsWith('/settings')){
      if(window.fixtureDeferSettings)return new Promise(resolve=>{fixturePendingResolve=resolve;});
      fixtureState.settings.reply_enabled=body.reply_enabled;fixtureState.settings.reminder_clock=body.reminder_clock;
      return {success:true};
    }
    return {success:true};
  }
};
`;

const browserChecks = `
(async()=>{
  const checks=[];
  function check(ok,label){if(!ok)throw new Error(label);checks.push(label);}
  const flush=()=>new Promise(resolve=>setTimeout(resolve,40));
  async function until(predicate){for(let attempt=0;attempt<100;attempt++){if(predicate())return;await flush();}throw new Error('Timed out waiting for settings UI');}
  await until(()=>document.querySelector('#notification-title'));
  const root=document.getElementById('notification-settings');
  check(typeof window.Notifications?.mount==='function','real app loads Notifications.mount');
  check(root.textContent.includes('Submission uncertain'),'real settings route mounts notification status');
  check(!root.querySelector('img'),'escapes provider error markup');
  check(root.textContent.includes('SAST'),'renders Johannesburg dates');
  check(root.textContent.includes('Email check-ins enabled'),'verified owner is ready without extra setup');
  check(root.textContent.includes('Confirm I’m here')&&root.textContent.includes('send the prefilled reply'),'explains one-button email confirmation');
  check(!/offline|two.factor|2FA|attestation/i.test(root.textContent)&&!root.querySelector('[data-notification-form="recovery-codes"]'),'does not offer a second-code workflow');
  check(root.querySelector('[data-notification-form="verify-start"]').closest('details')?.open===false,'verified address changes stay collapsed');
  const banner=document.querySelector('[aria-label="Isolated email acceptance"]');
  check(!!banner?.querySelector('form')&&!banner.querySelector('details'),'test reminder action is visible without extra setup panels');
  check(!/offline|two.factor|2FA/i.test(banner.textContent),'test banner has no second-code directions');
  banner.querySelector('input').value='fake-current-password';
  banner.querySelector('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));await flush();
  check(banner.querySelector('[data-result]').textContent.includes('click “Confirm I’m here”, then send the prefilled reply'),'test reminder provides the simple email action');
  banner.querySelector('[data-refresh]').click();await flush();
  check(banner.querySelector('[data-result]').textContent.includes('Accepted replies: 1'),'test result reports the accepted reply');
  const storageBefore=JSON.stringify({...localStorage});

  let form=root.querySelector('[data-notification-form="verify-start"]');
  form.closest('details').open=true;
  form.querySelector('[name="recipient"]').value='verified@example.com';
  form.querySelector('[name="password"]').value='wrong-password';
  form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));await flush();
  check(root.querySelector('[data-notification-feedback]').textContent==='Current vault password is incorrect','distinguishes vault-password failure from email verification');
  check(form.querySelector('[name="password"]').value==='','clears vault password after failed submit');
  check(!root.querySelector('[data-notification-form="verify-complete"]'),'failed password leaves verified address intact');
  form.querySelector('[name="password"]').value='fake-current-password';
  form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));await flush();
  check(fixtureCalls.some(call=>call.route==='/notifications/verify/start'&&call.body.recipient==='verified@example.com'&&call.body.password==='fake-current-password'),'protects address changes with the vault password');
  form=root.querySelector('[data-notification-form="verify-complete"]');
  check(!!form,'offers one-time email verification for the changed address');
  check(root.textContent.includes('enabled automatically'),'explains automatic enrollment after address verification');
  form.querySelector('[name="code"]').value='NV-FAKE-TEST-CODE';
  form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));await flush();
  check(root.textContent.includes('Email address verified. Email check-ins are enabled.'),'address verification enables email check-ins immediately');
  check(!root.querySelector('[data-notification-form="verify-complete"]'),'completed verification no longer asks for a code');
  check(JSON.stringify({...localStorage})===storageBefore,'does not persist verification inputs in localStorage');

  form=root.querySelector('[data-notification-form="settings"]');
  form.closest('details').open=true;
  form.querySelector('[name="password"]').value='fake-current-password';
  form.querySelector('[name="reminder_clock"]').value='08:30';
  form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));await flush();
  const put=fixtureCalls.find(call=>call.method==='PUT');
  check(put.body.reply_enabled&&put.body.timezone==='Africa/Johannesburg'&&put.body.reminder_clock==='08:30'&&put.body.password==='fake-current-password','saves protected fixed-timezone preferences without extra enrollment');
  check(!Object.hasOwn(put.body,'offline_stored_separately'),'requires no independent-code attestation');

  fixtureState.settings.recipient='\"><script>window.fixtureInjected=true<\\/script>';
  root.querySelector('[data-action="refresh"]').click();await flush();
  check(!window.fixtureInjected&&root.querySelector('#notification-recipient').value===fixtureState.settings.recipient,'escapes recipient attributes');
  window.fixtureDeferSettings=true;
  form=root.querySelector('[data-notification-form="settings"]');
  form.querySelector('[name="password"]').value='fake-current-password';
  form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));await flush();
  check(form.querySelector('[name="password"]').value==='','clears password while settings update is pending');
  window.location.hash='login';await until(()=>document.getElementById('login-form'));
  fixturePendingResolve({success:true});await flush();
  check(!document.getElementById('notification-settings')&&!document.getElementById('app').textContent.includes('preferences saved'),'late response does not restore removed settings');
  await fetch('/ui-test-result',{method:'POST',body:JSON.stringify({ok:true,checks})});
})().catch(async error=>{
  await fetch('/ui-test-result',{method:'POST',body:JSON.stringify({ok:false,error:error.message,stack:error.stack})});
});
`;

test('owner notification UI verifies once, enables simple email check-ins and cleans up navigation in Firefox', {
  timeout: 45000,
  skip: firefox ? false : 'Firefox not installed; set FIREFOX_BIN to run the real browser checks',
}, async t => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wolfs-email-ui-firefox-'));
  let browser;
  let browserErrors = '';
  let timer;
  let resolveResult;
  let rejectResult;
  const result = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
  const server = http.createServer((req, res) => {
    if (req.url === '/ui-test-result' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; if (body.length > 65536) req.destroy(); });
      req.on('end', () => {
        try { resolveResult(JSON.parse(body)); res.end('ok'); }
        catch (error) { rejectResult(error); res.writeHead(400).end(); }
      });
      return;
    }
    if (req.url === '/js/api.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(apiFixture); return; }
    if (req.url === '/') {
      const actualIndex = fs.readFileSync(path.join(publicRoot, 'index.html'), 'utf8');
      res.setHeader('Content-Type', 'text/html');
      const acceptanceClient = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'email-acceptance', 'client.js'), 'utf8');
      res.end(actualIndex.replace('</body>', `<script>${acceptanceClient}</script><script>${browserChecks}</script></body>`));
      return;
    }
    const pathname = String(req.url || '').split('?')[0];
    const file = path.resolve(publicRoot, '.' + pathname);
    if (!file.startsWith(publicRoot + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type', pathname.endsWith('.js') ? 'text/javascript' : pathname.endsWith('.css') ? 'text/css' : 'application/octet-stream');
    res.end(fs.readFileSync(file));
  });
  t.after(async () => {
    clearTimeout(timer);
    if (browser && browser.exitCode === null) {
      browser.kill('SIGTERM');
      await Promise.race([
        new Promise(resolve => browser.once('close', resolve)),
        new Promise(resolve => setTimeout(() => { browser.kill('SIGKILL'); resolve(); }, 2000).unref()),
      ]);
    }
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(profile, { recursive: true, force: true });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = spawn(firefox, ['--headless', '--no-remote', '--profile', profile, `http://127.0.0.1:${server.address().port}/#settings`], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  browser.stderr.on('data', chunk => { browserErrors = (browserErrors + String(chunk)).slice(-2000); });
  browser.once('error', rejectResult);
  browser.once('exit', code => { if (code !== null && code !== 0) rejectResult(new Error(`Firefox exited ${code}: ${browserErrors}`)); });
  timer = setTimeout(() => rejectResult(new Error(`Firefox UI checks timed out: ${browserErrors}`)), 30000);
  const report = await result;
  assert.equal(report.ok, true, [report.error, report.stack].filter(Boolean).join('\n'));
  assert.equal(report.checks.length, 26);
  t.diagnostic('Real index.html and settings route: ' + report.checks.join('; '));
});
