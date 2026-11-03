'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { apiFixture, createMobileFixtureServer } = require('./helpers/mobile-browser-fixture');

const firefox = [process.env.FIREFOX_BIN, '/usr/bin/firefox', '/usr/bin/firefox-esr'].filter(Boolean)
  .find(candidate => { try { fs.accessSync(candidate, fs.constants.X_OK); return true; } catch { return false; } });

// Run the real UI against invented API records. The transport never reaches the
// local vault, production, or notification services.
const fixtureScript = apiFixture + String.raw`
let autoAccessStatus='no_access';
fixtureRecipients[0].access_granted=0;
const autoWish=fixtureSync({...fixtureCopy(fixtureCommon),id:'automatic-alex',title:'Alex personal wish',type:'instruction',body_markdown:'',auto_generated:true,locked_beneficiary:{id:1,name:'Alex Example'},metadata:{origin:{type:'beneficiary',beneficiary_id:1},final_wishes:{content_type:'',category:'Beneficiary Instructions',contact_recipients:[]}},links:[{entry_id:12}]});
fixtureItems.push(autoWish);
const retiredWish={...fixtureCopy(fixtureCommon),id:'retired-wish',title:'Deleted beneficiary archive',type:'instruction',body_markdown:'Retained historical instructions',status:'archived',auto_generated:true,auto_wish_retired:true,locked_beneficiary:{id:99,name:'Deleted beneficiary'},beneficiary_ids:[],beneficiaries:[],metadata:{origin:{type:'beneficiary',beneficiary_id:99},final_wishes:{content_type:'',category:'Beneficiary Instructions'}}};
fixtureItems.push(retiredWish);

API.accessVault=async token=>{
 fixtureCalls.push({method:'accessVault',token});
 if(token!=='synthetic-recipient-token')throw new Error('Invalid or expired token');
 return {status:autoAccessStatus,personal_final_wish_available:!fixtureRecipients[0].auto_wish_access_revoked_at,owner:fixtureCopy(fixtureOwner),beneficiary:fixtureCopy(fixtureRecipients[0]),waitInfo:{access_at:'2026-12-01T10:00:00Z'},entries:fixtureCopy([fixtureEntries[1]])};
};
API.requestEmergency=async token=>{
 fixtureCalls.push({method:'requestEmergency',token});
 if(token!=='synthetic-recipient-token')throw new Error('Invalid or expired token');
 autoAccessStatus='waiting';return {status:'requested',waiting_days:7};
};
API.updateBeneficiary=async(id,body)=>{Object.assign(fixtureRecipients.find(row=>row.id===Number(id)),body);autoWish.locked_beneficiary.name=fixtureRecipients[0].name;return {};};
API.revokeAccess=async id=>{fixtureCalls.push({method:'revokeAccess',id});fixtureRecipients[0].auto_wish_access_revoked_at='2026-11-03T10:00:00Z';return {};};
const autoOriginalRequest=API.request.bind(API);
API.request=async(method,route,body)=>{
 if(route==='/final-wishes/preview')return {html:'<p>'+body.body_markdown+'</p>'};
 if(route==='/final-wishes/legacy/retired-wish'&&method==='DELETE'){fixtureCalls.push({method,route,body:fixtureCopy(body)});fixtureItems.splice(fixtureItems.indexOf(retiredWish),1);return {success:true};}
 if(route.endsWith('/restore-personal-wish-access')){fixtureCalls.push({method,route,body:fixtureCopy(body)});fixtureRecipients[0].auto_wish_access_revoked_at=null;return {success:true};}
 return autoOriginalRequest(method,route,body);
};
API.restorePersonalWishAccess=id=>API.request('POST','/beneficiaries/'+id+'/restore-personal-wish-access',{confirmed:true});
const autoOriginalFetch=window.fetch;
window.fetch=async(url,options={})=>{
 const route=String(url);
 if(!route.startsWith('/api/beneficiary-access/legacy'))return autoOriginalFetch(url,options);
 fixtureCalls.push({method:options.method||'GET',route,headers:options.headers,body:typeof options.body==='string'?JSON.parse(options.body):undefined});
 const headers={'Content-Type':'application/json'};
 if(options.headers?.Authorization!=='Bearer synthetic-recipient-token')return new Response('{"error":"Invalid token"}',{status:403,headers});
 const personal=fixtureRecipients[0].auto_wish_access_revoked_at||autoWish.status==='archived'?[]:[{...fixtureCopy(autoWish),access_scope:'personal_final_wish',body_html:autoWish.body_markdown?'<p>'+autoWish.body_markdown+'</p>':''}];
 const released=autoAccessStatus==='granted'?[{...fixtureCopy(fixtureItems.find(item=>item.id==='instructions-1')),access_scope:'released_content'}]:[];
 const available=[...personal,...released];
 if(route==='/api/beneficiary-access/legacy')return new Response(JSON.stringify([...available,...personal]),{headers});
 const item=available.find(item=>item.id===route.split('/')[4]);
 return new Response(JSON.stringify(item||{error:'Not found'}),{status:item?200:404,headers});
};
`;

async function runAutomaticWishWorkflow() {
  const checks = [];
  const check = (value, label) => { if (!value) throw new Error(label); checks.push(label); };
  const pause = () => new Promise(resolve => setTimeout(resolve, 25));
  const until = async (predicate, label) => { for (let n = 0; n < 180; n++) { if (predicate()) return; await pause(); } throw new Error('Timed out: ' + label); };
  const fits = label => check(document.documentElement.scrollWidth <= innerWidth + 1, label + ' fits viewport');
  const route = async (hash, selector) => { location.hash = hash; await until(() => document.querySelector(selector), hash); await pause(); };
  const submitToken = async () => {
    const form = document.querySelector('#access-form');
    form.elements.token.value = 'synthetic-recipient-token';
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await until(() => document.querySelector('#beneficiary-legacy-root [data-recipient-refresh]'), 'token content response');
  };
  const action = name => document.querySelector('[data-legacy-action="' + name + '"]');
  await until(() => document.querySelector('.vault-grid'), 'owner dashboard');
  await route('access', '#access-form');
  await submitToken();
  check(document.querySelector('#access-result').textContent.includes('General vault access not yet granted'), 'no_access preserves the general vault lock');
  check(document.querySelectorAll('[data-recipient-content]').length === 1 && document.querySelector('[data-recipient-content="automatic-alex"]'), 'valid token mounts its dedicated wish once without a general grant');
  check(!document.querySelector('#access-result').textContent.includes('Example family home') && !document.querySelector('[data-recipient-linked-entry]'), 'no_access ignores unrelated vault records in the response');
  check(document.querySelector('#beneficiary-legacy-root').textContent.includes('Personal Final Wish') && !document.querySelector('#beneficiary-legacy-root').textContent.includes('Released content'), 'automatic wish is labelled as personal rather than released');
  fits('Locked vault with personal wish');
  const ordinaryAccess = API.accessVault;
  let finishSlowAccess;
  API.accessVault = token => token === 'slow-synthetic-token' ? new Promise(resolve => { finishSlowAccess = async () => resolve(await ordinaryAccess('synthetic-recipient-token')); }) : ordinaryAccess(token);
  let tokenForm = document.querySelector('#access-form');
  tokenForm.elements.token.value = 'slow-synthetic-token';
  tokenForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  tokenForm.elements.token.value = 'invalid-synthetic-token';
  tokenForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await until(() => document.querySelector('#access-result').textContent.includes('Invalid or expired token'), 'invalid token rejected');
  await finishSlowAccess(); await pause();
  check(!document.querySelector('[data-recipient-content]') && document.querySelector('#access-result').textContent.includes('Invalid or expired token'), 'a stale valid request cannot replace the latest rejected token result');
  API.accessVault = ordinaryAccess;
  await submitToken();
  document.querySelector('[data-recipient-content]').click();
  await until(() => document.querySelector('[data-recipient-back]'), 'empty wish detail');
  check(document.querySelector('#beneficiary-legacy-root').textContent.includes('No written message.') && !document.querySelector('[data-recipient-linked-entry]'), 'empty initial wish renders without exposing linked vault content');
  autoAccessStatus = 'waiting';
  await route('login', '#login-form');
  await route('access', '#access-form');
  await submitToken();
  check(document.querySelector('#access-result').textContent.includes('Pending. Access on') && document.querySelectorAll('[data-recipient-content]').length === 1 && !document.querySelector('#access-result').textContent.includes('Example family home'), 'waiting retains its notice and only the personal wish');
  await route('login', '#login-form'); await route('access', '#access-form');
  document.querySelector('#access-form').elements.token.value = 'synthetic-recipient-token';
  document.querySelector('#access-form [value="emergency"]').click();
  await until(() => document.querySelector('[data-recipient-content="automatic-alex"]'), 'emergency request personal content');
  check(document.querySelector('#access-result').textContent.includes('Emergency access requested.') && !document.querySelector('.vault-readonly') && document.querySelectorAll('[data-recipient-content]').length === 1, 'successful emergency token submission keeps its waiting notice and mounts only personal content');


  await route('section/final_wishes/automatic-alex', '[data-legacy-action="edit"]');
  check(!action('delete') && action('archive') && document.querySelector('[data-locked-beneficiary="1"]'), 'automatic detail keeps its locked identity and offers archive without delete');
  action('edit').click(); await until(() => document.querySelector('#legacy-editor'), 'locked owner editor');
  let editor = document.querySelector('#legacy-editor');
  check(editor.querySelector('[data-locked-beneficiary="1"]').textContent.includes('Alex Example') && editor.textContent.includes('Recipients cannot be changed.'), 'automatic editor names the locked beneficiary and explains the restriction');
  check(!editor.querySelector('#legacy-recipient-search,[data-add-recipient],[data-remove-recipient]'), 'automatic editor contains no beneficiary or contact recipient picker');
  check(editor.textContent.includes('including draft edits') && !editor.textContent.includes('Drafts stay private.'), 'automatic editor explains immediate personal token visibility');
  editor.elements.body_markdown.value = 'Latest personal instructions';
  editor.elements.wish_contact_person.value = 'Informational contact';
  const injected = document.createElement('input'); injected.type = 'hidden'; injected.name = 'beneficiary_ids'; injected.value = '2'; editor.appendChild(injected);
  fits('Automatic wish editor');
  editor.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await until(() => action('edit') && !document.querySelector('#legacy-editor'), 'saved automatic wish');
  const saved = fixtureCalls.find(call => call.method === 'PATCH' && call.route === '/final-wishes/legacy/automatic-alex' && call.body.metadata);
  check(saved.body.beneficiary_ids.length === 1 && saved.body.beneficiary_ids[0] === 1 && saved.body.metadata.final_wishes.contact_recipients.length === 0 && saved.body.metadata.origin.beneficiary_id === 1, 'owner edits keep the same recipient and origin even if extra form controls are injected');
  check(autoWish.body_markdown === 'Latest personal instructions' && saved.body.metadata.final_wishes.contact_person === 'Informational contact', 'ordinary message and informational contact fields remain editable on the same wish');
  await route('beneficiaries', '[data-legacy-beneficiary="1"]');
  document.querySelector('[data-legacy-beneficiary="1"]').open = true;
  await until(() => document.querySelector('[data-legacy-recipient-items] [data-locked-beneficiary="1"]'), 'beneficiary content summary');
  check(document.querySelector('[data-legacy-recipient-items] a[href="#section/final_wishes/automatic-alex"]') && document.querySelector('[data-legacy-recipient-items]').textContent.includes('Recipients cannot be changed.'), 'beneficiary summary points to the same wish with a locked recipient');
  document.querySelector('[data-edit="1"]').click(); await until(() => document.querySelector('#edit-ben-form'), 'beneficiary rename');
  document.querySelector('#edit-ben-form').elements.name.value = 'Alex Updated';
  document.querySelector('#edit-ben-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await until(() => !document.querySelector('#edit-ben-form') && document.querySelector('[data-edit="1"]'), 'renamed beneficiary');
  await route('section/final_wishes/automatic-alex', '[data-legacy-action="edit"]');
  check(document.querySelector('[data-locked-beneficiary="1"]').textContent.includes('Alex Updated'), 'renamed beneficiary keeps the immutable ID and current display name');

  await route('access', '#access-form'); await submitToken();
  document.querySelector('[data-recipient-content="automatic-alex"]').click();
  await until(() => document.querySelector('[data-recipient-back]'), 'updated recipient read');
  check(document.querySelector('#beneficiary-legacy-root').textContent.includes('Latest personal instructions'), 'next token retrieval shows the owner edit on the same wish');
  autoWish.body_markdown = 'Refreshed personal instructions';
  document.querySelector('[data-recipient-refresh]').click();
  await until(() => document.querySelector('[data-recipient-content="automatic-alex"]'), 'refresh list');
  document.querySelector('[data-recipient-content="automatic-alex"]').click();
  await until(() => document.querySelector('#beneficiary-legacy-root').textContent.includes('Refreshed personal instructions'), 'refreshed detail');
  check(!fixtureCalls.some(call => call.route?.includes('synthetic-recipient-token')) && !Object.keys(localStorage).some(key => String(localStorage.getItem(key)).includes('synthetic-recipient-token')), 'recipient token stays out of URLs and local storage');
  autoAccessStatus = 'granted';
  await route('login', '#login-form'); await route('access', '#access-form'); await submitToken();
  await until(() => document.querySelector('.vault-readonly'), 'general access granted');
  check(document.querySelectorAll('[data-recipient-content="automatic-alex"]').length === 1 && document.querySelectorAll('[data-recipient-content]').length === 2 && document.querySelector('.vault-readonly').textContent.includes('Example family home'), 'granted view adds authorised vault and released content without duplicating the personal wish');

  await route('beneficiaries', '[data-revoke="1"]');
  document.querySelector('[data-revoke="1"]').click();
  await until(() => document.querySelector('[data-restore-personal-wish="1"]'), 'explicit personal revoke');
  autoAccessStatus = 'no_access';
  await route('access', '#access-form'); await submitToken();
  check(!document.querySelector('[data-recipient-content]') && document.querySelector('#beneficiary-legacy-root').textContent.includes('No shared personal content'), 'revoked token scope renders no personal wish');
  await route('beneficiaries', '[data-restore-personal-wish="1"]');
  window.confirm = () => false;
  document.querySelector('[data-restore-personal-wish="1"]').click(); await pause();
  check(!fixtureCalls.some(call => call.route?.endsWith('/restore-personal-wish-access')), 'cancelled restoration performs no request');
  window.confirm = () => true;
  document.querySelector('[data-restore-personal-wish="1"]').click();
  await until(() => !document.querySelector('[data-restore-personal-wish="1"]'), 'intentional restore');
  check(fixtureCalls.some(call => call.route === '/beneficiaries/1/restore-personal-wish-access' && call.body.confirmed === true) && fixtureRecipients[0].access_granted === 0, 'confirmed restore requests only the personal entitlement');
  await route('access', '#access-form'); await submitToken();
  check(document.querySelector('[data-recipient-content="automatic-alex"]') && !document.querySelector('.vault-readonly'), 'restored entitlement reveals the personal wish without full vault access');
  fits('Restored personal wish');
  await route('section/final_wishes/retired-wish', '[data-legacy-action="delete"][data-item-id="retired-wish"]');
  check(document.querySelector('.legacy-detail').textContent.includes('Retained historical instructions') && document.querySelector('.legacy-detail').textContent.includes('cannot be edited, restored or reassigned'), 'retired automatic archive preserves readable history and explains its permanent recipient lock');
  check(!action('edit') && !action('ready') && !action('archive') && !action('release') && !document.querySelector('#legacy-editor'), 'retired automatic archive offers no editing or restoration controls');
  fits('Retired automatic archive');
  action('delete').click();
  await until(() => document.querySelector('.legacy-list'), 'retired archive deleted');
  check(fixtureCalls.some(call => call.method === 'DELETE' && call.route === '/final-wishes/legacy/retired-wish' && call.body.confirm_delete === true) && !document.querySelector('[data-item-id="retired-wish"]'), 'retired archive can be permanently deleted through the existing confirmed workflow');
  check(!document.querySelector('[data-legacy-action="delete"][data-item-id="automatic-alex"]'), 'active automatic wishes still prohibit ordinary deletion');
  return checks;
}

for (const width of [1440, 390]) {
  test(`automatic Final Wish owner and token flows work in Firefox at ${width}px`, {
    timeout: 60000,
    skip: firefox ? false : 'Firefox not installed; set FIREFOX_BIN for browser acceptance',
  }, async t => {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wolfs-auto-wish-ui-'));
    let browser;
    let timer;
    let browserErrors = '';
    let resolveResult;
    let rejectResult;
    const result = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
    const checks = `(${runAutomaticWishWorkflow.toString()})().then(checks=>fetch('/mobile-test-result',{method:'POST',body:JSON.stringify({ok:true,width:innerWidth,checks})})).catch(error=>fetch('/mobile-test-result',{method:'POST',body:JSON.stringify({ok:false,error:error.message,stack:error.stack})}));`;
    const fixture = await createMobileFixtureServer({ checks, fixtureScript, onResult: resolveResult });
    t.after(async () => {
      clearTimeout(timer);
      if (browser && browser.exitCode === null) {
        browser.kill('SIGTERM');
        await Promise.race([new Promise(resolve => browser.once('close', resolve)), new Promise(resolve => setTimeout(() => { browser.kill('SIGKILL'); resolve(); }, 2000).unref())]);
      }
      await fixture.close();
      fs.rmSync(profile, { recursive: true, force: true });
    });
    browser = spawn(firefox, ['--headless', '--no-remote', '--profile', profile, '--width', String(width === 390 ? 820 : width), '--height', '1000', fixture.origin + (width === 390 ? '/?mobile-frame=390' : '/#vault')], { stdio: ['ignore', 'ignore', 'pipe'] });
    browser.stderr.on('data', chunk => { browserErrors = (browserErrors + String(chunk)).slice(-3000); });
    browser.once('error', rejectResult);
    browser.once('exit', code => { if (code !== null && code !== 0) rejectResult(new Error(`Firefox exited ${code}: ${browserErrors}`)); });
    timer = setTimeout(() => rejectResult(new Error(`Automatic wish browser checks timed out: ${browserErrors}`)), 45000);
    const report = await result;
    assert.equal(report.ok, true, [report.error, report.stack].filter(Boolean).join('\n'));
    assert.equal(report.width, width);
    assert.ok(report.checks.length >= 20);
    t.diagnostic(report.checks.join('; '));
  });
}
