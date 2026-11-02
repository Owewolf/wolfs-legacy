'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

// Load the real application, API client and settings UI. Every API response is
// synthetic and intercepted in-browser; no vault database or SMS provider loads.
const firefox = [process.env.FIREFOX_BIN, '/usr/bin/firefox', '/usr/bin/firefox-esr']
  .filter(Boolean).find(candidate => { try { fs.accessSync(candidate, fs.constants.X_OK); return true; } catch { return false; } });
const publicRoot = path.join(__dirname, '..', 'public');

const fixture = `
localStorage.setItem('lv_token','synthetic-pre-enrollment-session');
const fixtureCalls=[];
let fixtureEnabled=false;
const fixtureEnrollmentCodes=['SYNTHETIC-RECOVERY-ONE','<img src=x onerror="window.fixtureInjected=true">'];
const fixtureRotatedCodes=['SYNTHETIC-ROTATED-ONE','SYNTHETIC-ROTATED-TWO'];
const fixtureOriginalFetch=window.fetch.bind(window);
window.fetch=async(input,options={})=>{
  const url=String(input);
  if(!url.startsWith('/api/')){
    if(url.startsWith('/')||url.startsWith(location.origin+'/'))return fixtureOriginalFetch(input,options);
    throw new Error('External requests are disabled in the synthetic SMS fixture');
  }
  const route=url.slice(4),method=options.method||'GET';
  const headers=new Headers(options.headers);
  const body=options.body?JSON.parse(options.body):undefined;
  const auth=headers.get('Authorization');
  fixtureCalls.push({route,method,auth,body});
  const response=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
  if(fixtureEnabled&&auth!=='Bearer synthetic-mfa-session')return response({error:'Second-factor verification required'},403);
  if(route==='/auth/me')return response({id:1,name:'Synthetic owner',email:'owner@example.test',sms_2fa_enabled:fixtureEnabled?1:0});
  if(route==='/auth/2fa/status')return response({enabled:fixtureEnabled,masked_phone:fixtureEnabled?'+27******567':'',recovery_codes_remaining:fixtureEnabled?2:0});
  if(route==='/auth/2fa/enroll/start')return response({challenge_id:'synthetic-enroll-id',challenge_token:'synthetic-enroll-token',resend_available_at:new Date(Date.now()+60000).toISOString()});
  if(route==='/auth/2fa/enroll/verify'){
    fixtureEnabled=true;
    return response({success:true,masked_phone:'+27******567',recovery_codes:fixtureEnrollmentCodes,token:'synthetic-mfa-session',user:{id:1,name:'Synthetic owner',email:'owner@example.test'}});
  }
  if(route==='/auth/2fa/recovery/regenerate'){
    if(body.current_password==='wrong')return response({error:'Current password is incorrect'},401);
    return response({recovery_codes:fixtureRotatedCodes});
  }
  if(route==='/notifications')return response({settings:null,health:[],outbox:[],transport_configured:false,reply_transport_configured:false});
  return response({error:'Unexpected synthetic API route: '+route},404);
};
`;

const browserChecks = `
(async()=>{
  const checks=[];
  function check(value,label){if(!value)throw new Error(label);checks.push(label);}
  const flush=()=>new Promise(resolve=>setTimeout(resolve,40));
  async function until(predicate,label){for(let n=0;n<100;n++){if(predicate())return;await flush();}throw new Error('Timed out: '+label);}
  const statusCalls=()=>fixtureCalls.filter(call=>call.route==='/auth/2fa/status').length;
  const submit=form=>form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
  await until(()=>document.getElementById('twofa-enroll-form'),'settings');
  check(document.getElementById('twofa-status').textContent.includes('Not enabled'),'starts with the pre-enrollment session');
  const enroll=document.getElementById('twofa-enroll-form');
  enroll.querySelector('[name="phone"]').value='+27821234567';
  enroll.querySelector('[name="current_password"]').value='synthetic-password';
  submit(enroll);
  await until(()=>document.getElementById('twofa-verify-wrap').style.display!=='none','enrollment challenge');
  const start=fixtureCalls.find(call=>call.route==='/auth/2fa/enroll/start');
  check(start.body.phone==='+27821234567'&&start.auth==='Bearer synthetic-pre-enrollment-session','enrollment submits the chosen phone using the existing session');
  const verify=document.getElementById('twofa-verify-form');
  verify.querySelector('[name="otp"]').value='123456';
  submit(verify);
  await until(()=>document.getElementById('recovery-codes-continue'),'enrollment recovery codes');
  let panel=document.getElementById('recovery-codes-panel');
  check(API.token==='synthetic-mfa-session'&&localStorage.getItem('lv_token')==='synthetic-mfa-session','successful enrollment stores the upgraded MFA session');
  check(document.getElementById('twofa-status').textContent.includes('Enabled for +27******567'),'enrollment updates visible enabled status without replacing recovery codes');
  check(document.getElementById('twofa-phone').textContent==='+27******567','enrollment updates the masked phone');
  check(panel.textContent.includes(fixtureEnrollmentCodes[0])&&panel.textContent.includes(fixtureEnrollmentCodes[1]),'all issued recovery codes remain readable');
  check(!panel.querySelector('img')&&!window.fixtureInjected,'recovery codes render as escaped text');
  check(document.activeElement===panel,'recovery code region receives keyboard focus');
  check(enroll.querySelector('[name="current_password"]').value===''&&verify.querySelector('[name="otp"]').value==='','successful enrollment clears password and SMS code inputs');
  check(document.getElementById('twofa-verify-wrap').style.display==='none','completed enrollment hides its spent challenge');
  const callsBeforeContinue=statusCalls();
  await new Promise(resolve=>setTimeout(resolve,250));
  check(panel.isConnected&&panel.textContent.includes(fixtureEnrollmentCodes[0])&&statusCalls()===callsBeforeContinue,'recovery codes stay visible while waiting for explicit confirmation');
  const stored=JSON.stringify({...localStorage,...sessionStorage});
  check(!stored.includes('SYNTHETIC-RECOVERY')&&!stored.includes('synthetic-password')&&!stored.includes('123456'),'recovery codes and submitted secrets are never saved in browser storage');
  document.getElementById('recovery-codes-continue').click();
  await until(()=>statusCalls()===callsBeforeContinue+1&&document.getElementById('recovery-codes-panel')!==panel,'explicit continuation refresh');
  check(panel.textContent===''&&!document.getElementById('recovery-codes-continue'),'explicit continuation clears the one-time code display');
  check(fixtureCalls.filter(call=>call.route==='/auth/2fa/status').at(-1).auth==='Bearer synthetic-mfa-session','the refreshed protected settings use the upgraded session');
  check(document.getElementById('twofa-status').textContent.includes('Enabled'),'protected settings remain accessible after enrollment');
  const recovery=document.getElementById('twofa-recovery-form');
  recovery.querySelector('[name="current_password"]').value='synthetic-current-password';
  submit(recovery);
  await until(()=>document.getElementById('recovery-codes-continue'),'rotated codes');
  panel=document.getElementById('recovery-codes-panel');
  check(fixtureRotatedCodes.every(code=>panel.textContent.includes(code))&&!panel.textContent.includes(fixtureEnrollmentCodes[0]),'regeneration shows the newly issued codes');
  check(recovery.querySelector('[name="current_password"]').value==='','regeneration clears the current password');
  const callsBeforeRotationContinue=statusCalls();
  await new Promise(resolve=>setTimeout(resolve,250));
  check(panel.isConnected&&statusCalls()===callsBeforeRotationContinue,'regeneration retains codes until explicit continuation');
  recovery.querySelector('[name="current_password"]').value='wrong';
  submit(recovery);await flush();
  check(fixtureRotatedCodes.every(code=>panel.textContent.includes(code)),'a failed regeneration leaves the last issued codes visible');
  check(!JSON.stringify({...localStorage,...sessionStorage}).includes('SYNTHETIC-ROTATED'),'regenerated codes are not persisted');
  document.getElementById('recovery-codes-continue').click();
  await until(()=>statusCalls()===callsBeforeRotationContinue+1&&document.getElementById('recovery-codes-panel')!==panel,'rotated code confirmation');
  check(panel.textContent===''&&!document.getElementById('app').textContent.includes('SYNTHETIC-ROTATED'),'confirming rotated codes removes their text');
  check(fixtureCalls.filter(call=>call.route==='/auth/2fa/recovery/regenerate').every(call=>call.auth==='Bearer synthetic-mfa-session'),'recovery regeneration uses the upgraded MFA session');
  await fetch('/ui-test-result',{method:'POST',body:JSON.stringify({ok:true,checks})});
})().catch(async error=>{
  await fetch('/ui-test-result',{method:'POST',body:JSON.stringify({ok:false,error:error.message,stack:error.stack})});
});
`;

test('SMS enrollment upgrades the session and keeps one-time recovery codes visible until confirmation in Firefox', {
  timeout: 45000,
  skip: firefox ? false : 'Firefox not installed; set FIREFOX_BIN to run the real browser checks',
}, async t => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wolfs-sms-ui-firefox-'));
  let browser, timer, resolveResult, rejectResult;
  let browserErrors = '';
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
    if (req.url === '/') {
      const index = fs.readFileSync(path.join(publicRoot, 'index.html'), 'utf8');
      res.setHeader('Content-Type', 'text/html');
      res.end(index.replace('<div id="app"></div>', `<div id="app"></div><script>${fixture}</script>`)
        .replace('</body>', `<script>${browserChecks}</script></body>`));
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
  timer = setTimeout(() => rejectResult(new Error(`Firefox SMS UI checks timed out: ${browserErrors}`)), 30000);
  const report = await result;
  assert.equal(report.ok, true, [report.error, report.stack].filter(Boolean).join('\n'));
  assert.equal(report.checks.length, 22);
  t.diagnostic(report.checks.join('; '));
});
