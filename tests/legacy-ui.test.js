'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

// Real application scripts and CSS run in Firefox against synthetic owner and
// recipient records. This verifies the interactions and browser safety boundary.
const firefox = [process.env.FIREFOX_BIN, '/usr/bin/firefox', '/usr/bin/firefox-esr']
  .filter(Boolean).find(candidate => { try { fs.accessSync(candidate, fs.constants.X_OK); return true; } catch { return false; } });
const publicRoot = path.join(__dirname, '..', 'public');

const apiFixture = `
const fixtureCalls=[];
const fixtureRecipients=[{id:1,name:'Alex Example',relationship:'Child',access_granted:1,emergency_waiting_days:7,created_at:'2026-10-20T10:00:00Z'},{id:2,name:'Jamie Example',relationship:'Sibling',access_granted:0,emergency_waiting_days:7,created_at:'2026-10-20T10:00:00Z'}];
const fixtureEntries=[{id:11,title:'Memorial arrangements',section:'final_wishes',fields:{category:'Memorial Preferences',details:'Existing final wish retained',contact_person:'Family contact',contact_phone:'000 000 0000'},notes:''},{id:12,title:'Example family home',section:'real_estate',fields:{address:'Example address'},notes:''}];
const common={body_markdown:'A personal message',introduction:'',description:'',release_policy:'owner_only',status:'draft',beneficiary_ids:[1],metadata:{},links:[],beneficiaries:[],attachments:[],versions:[],reviews:[],release_events:[],review_enabled:false,revision:1,created_at:'2026-10-20T10:00:00Z',updated_at:'2026-10-28T10:00:00Z'};
const fixtureItems=[
{...structuredClone(common),id:'letter-1',title:'A letter for Alex',type:'letter',description:'A private letter for a future birthday'},
{...structuredClone(common),id:'memory-1',title:'Family picnic',type:'family_history',metadata:{event_date:'1985',date_precision:'approximate',people:['Alex Example'],tags:['family'],place:'Example park'}},
{...structuredClone(common),id:'memory-2',title:'An undated photograph',type:'family_history',metadata:{date_precision:'unknown',people:['Jamie Example']}},
{...structuredClone(common),id:'instructions-1',title:'Household handover',type:'instruction',body_markdown:'Check the garden each week.',status:'released',release_policy:'manual_release',review_enabled:true,review_interval_months:12,next_review_at:'2026-11-01T00:00:00Z',review_state:'due_soon',metadata:{category:'maintenance',priority:'normal',checklist:[{id:'water-garden',text:'Water the garden'},{id:'call-service',text:'Contact the maintenance service'}]},links:[{entry_id:12}],attachments:[{id:'recording-1',display_name:'Garden instructions.wav',mime_type:'audio/wav',size_bytes:128,sha256:'a'.repeat(64)}],beneficiaries:[{beneficiary_id:1,name:'Alex Example',released_at:'2026-10-28T10:00:00Z',revoked_at:null,release_scope:'manual_release'}]}
];
const fixtureCopy=value=>structuredClone(value);
function fixtureSync(item){item.beneficiaries=item.beneficiary_ids.map(id=>item.beneficiaries?.find(row=>row.beneficiary_id===id)||{beneficiary_id:id,name:fixtureRecipients.find(recipient=>recipient.id===id).name,released_at:null,revoked_at:null});return item;}
fixtureItems.forEach(fixtureSync);
const API={
 token:'synthetic-owner-session',setToken(value){this.token=value;},
 async getMe(){return {id:1,name:'Example owner',email:'owner@example.test'};},
 async getSummary(){return [{section:'final_wishes',count:1},{section:'real_estate',count:1}];},
 async getEntries(section){return {entries:fixtureCopy(fixtureEntries.filter(entry=>!section||entry.section===section)),pages:1};},
 async getEntry(id){return fixtureCopy(fixtureEntries.find(entry=>String(entry.id)===String(id)));},
 async getBeneficiaries(){return fixtureCopy(fixtureRecipients);},
 async request(method,route,body){
  fixtureCalls.push({method,route,body});
  if(route==='/final-wishes/config')return {max_file_bytes:25*1024*1024,accepted:['.pdf','.png','.mp3','.m4a','.wav','.mp4','.mov']};
  if(route.startsWith('/vault/entries'))return {entries:fixtureCopy(fixtureEntries),pages:1};
  if(route==='/final-wishes/preview')return {html:'<p><strong>Safe Markdown preview</strong></p><img src="https://invalid.example/track" onerror="window.fixtureInjected=true"><script>window.fixtureInjected=true<\\/script><a href="javascript:alert(1)">Unsafe link</a>'};
  if(route.startsWith('/beneficiaries/'))return fixtureCopy(fixtureItems.filter(item=>item.beneficiary_ids.includes(Number(route.split('/')[2]))).map(item=>({...item,...item.beneficiaries.find(row=>row.beneficiary_id===Number(route.split('/')[2]))})));
  if(route.startsWith('/final-wishes/legacy?')){
   const query=new URLSearchParams(route.split('?')[1]);let items=fixtureItems;
   if(query.get('q'))items=items.filter(item=>JSON.stringify(item).toLowerCase().includes(query.get('q').toLowerCase()));
   if(query.get('status'))items=items.filter(item=>item.status===query.get('status'));
   return fixtureCopy(items);
  }
  if(route==='/final-wishes/legacy'&&method==='GET')return fixtureCopy(fixtureItems);
  if(route==='/final-wishes/legacy'&&method==='POST'){const item=fixtureSync({...structuredClone(common),...fixtureCopy(body),id:'created-item'});fixtureItems.push(item);return fixtureCopy(item);}
  const id=route.split('/')[3],item=fixtureItems.find(row=>row.id===id);
  if(!item)throw new Error('Fixture route not found: '+route);
  if(method==='GET')return fixtureCopy(item);
  if(method==='PATCH'){item.versions.push({revision:item.revision,payload:{title:item.title,body_markdown:item.body_markdown},created_at:common.updated_at});if(item.status==='released'){item.status='draft';item.beneficiaries.forEach(row=>{row.released_at=null;});}Object.assign(item,body);item.revision++;fixtureSync(item);return fixtureCopy(item);}
  if(route.endsWith('/release')){item.status='released';item.beneficiaries.filter(row=>body.beneficiary_ids.includes(row.beneficiary_id)).forEach(row=>{row.released_at=common.updated_at;row.revoked_at=null;});item.release_events.push({event_type:'manual_release',created_at:common.updated_at});return fixtureCopy(item);}
  if(route.endsWith('/revoke')){item.beneficiaries.filter(row=>body.beneficiary_ids.includes(row.beneficiary_id)).forEach(row=>{row.revoked_at=common.updated_at;});return fixtureCopy(item);}
  if(route.endsWith('/review')){item.reviews.push({action:body.action,created_at:common.updated_at});item.last_reviewed_at=common.updated_at;item.review_state='current';if(body.next_review_at)item.next_review_at=body.next_review_at;if(body.action==='disable')item.review_enabled=false;return fixtureCopy(item);}
  if(method==='DELETE'){item.status='archived';return {ok:true};}
  throw new Error('Unhandled fixture route: '+route);
 }
};
const originalFixtureFetch=window.fetch.bind(window);
window.fetch=async(url,options={})=>{
 if(String(url).startsWith('/api/documents/counts'))return new Response('[]',{headers:{'Content-Type':'application/json'}});
 if(String(url).startsWith('/api/beneficiary-access/legacy')){
  fixtureCalls.push({method:options.method||'GET',route:String(url),headers:options.headers,body:options.body?JSON.parse(options.body):undefined});
  if(options.headers.Authorization!=='Bearer synthetic-recipient-token')return new Response('{"error":"Access denied"}',{status:403,headers:{'Content-Type':'application/json'}});
  const item=fixtureCopy(fixtureItems.find(row=>row.id==='instructions-1'));item.body_html='<p><strong>Check the garden each week.</strong></p><img src="https://invalid.example/track">';item.acknowledgements=[];
  if(String(url).includes('/attachments/'))return new Response(new Uint8Array(128),{headers:{'Content-Type':'audio/wav'}});
  if(String(url).endsWith('/acknowledgements'))return new Response('{"ok":true}',{headers:{'Content-Type':'application/json'}});
  const content=String(url)==='/api/beneficiary-access/legacy'?[item]:item;
  return new Response(JSON.stringify(content),{headers:{'Content-Type':'application/json'}});
 }
 return originalFixtureFetch(url,options);
};
`;

const browserChecks = `
(async()=>{
 const checks=[];
 function check(value,label){if(!value)throw new Error(label);checks.push(label);}
 const flush=()=>new Promise(resolve=>setTimeout(resolve,30));
 async function until(predicate,label){for(let n=0;n<120;n++){if(predicate())return;await flush();}throw new Error('Timed out: '+label);}
 const workspace=()=>document.getElementById('legacy-workspace');
 const action=name=>workspace()?.querySelector('[data-legacy-action="'+name+'"]');
 await until(()=>action('new'),'owner content groups');
 check(document.querySelectorAll('.legacy-tabs button').length===6,'extends Final Wishes with five groups and All content');
 check(document.querySelector('.legacy-existing-wishes').textContent.includes('Existing final wish retained'),'preserves existing Final Wishes fields and arrangements');
 check(!Array.from(document.querySelectorAll('.sidebar .nav-item')).some(item=>item.textContent.includes('Personal Legacy')),'adds no top-level legacy section');
 workspace().querySelector('[data-legacy-group="letter"]').click();action('new').click();
 await until(()=>document.getElementById('legacy-editor'),'new letter editor');
 let form=document.getElementById('legacy-editor');
 check(form.elements.release_policy.value==='owner_only'&&form.elements.status.value==='draft','new content defaults to private draft');
 check(form.querySelector('#doc-file-input').accept.includes('.mp4')&&form.querySelector('#doc-drop').tabIndex===0,'reuses accessible managed document picker and drop area for media');
 form.elements.title.value='<img src=x onerror="window.fixtureInjected=true"> Letter for family';
 form.elements.body_markdown.value='# Message\\n**Family**';
 form.elements.release_policy.value='manual_release';
 form.querySelectorAll('[name="beneficiary_ids"]').forEach(control=>control.checked=true);
 form.querySelector('[name="link_ids"][value="12"]').checked=true;
 action('markdown-preview').click();await until(()=>!document.getElementById('legacy-editor-preview').hidden,'Markdown preview');
 const rendered=document.getElementById('legacy-editor-preview');
 check(!!rendered.querySelector('strong')&&!rendered.querySelector('img,script,iframe')&&!rendered.querySelector('a[href]')&&!window.fixtureInjected,'Markdown preview keeps formatting and removes executable HTML, unsafe links and remote tracking');
 form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
 await until(()=>action('ready'),'saved draft detail');
 const create=fixtureCalls.find(call=>call.method==='POST'&&call.route==='/final-wishes/legacy');
 check(create.body.beneficiary_ids.length===2&&create.body.links[0].entry_id===12,'one content record holds multiple recipients and existing vault links');
 check(!workspace().querySelector('img')&&!window.fixtureInjected&&workspace().textContent.includes('<img src=x'),'escapes personal content titles in management');
 check(workspace().querySelector('a[href="#edit/real_estate/12"]'),'shows a useful link to the existing property record');
 action('ready').click();await until(()=>action('release'),'ready item detail');
 action('release').click();
 let dialog=document.querySelector('[aria-labelledby="legacy-release-dialog"]');
 check(dialog&&!dialog.querySelector('[name="confirmed"]').checked&&!fixtureCalls.some(call=>call.route.endsWith('/release')),'manual release waits for explicit confirmation');
 dialog.querySelector('[name="confirmed"]').checked=true;
 dialog.querySelector('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
 await until(()=>action('revoke'),'released item detail');
 check(fixtureCalls.some(call=>call.route.endsWith('/release')&&call.body.confirm===true&&call.body.beneficiary_ids.length===2),'confirmed release targets selected existing beneficiaries');
 action('preview').click();await until(()=>workspace().textContent.includes('Owner preview of the recipient'),'recipient preview');
 check(!action('release')&&!workspace().textContent.includes('Revision history'),'recipient preview shows content without owner management history');
 action('open').click();await until(()=>action('edit'),'return to management');action('edit').click();
 await until(()=>document.getElementById('legacy-editor'),'released content editor');
 check(workspace().textContent.includes('clears previous releases')&&document.getElementById('legacy-editor').elements.status.value==='draft','editing released content explains and defaults to a new draft');
 form=document.getElementById('legacy-editor');form.elements.body_markdown.value='Updated message';form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
 await until(()=>action('ready'),'updated draft detail');
 check(workspace().textContent.includes('Revision history (')&&workspace().querySelector('.legacy-history-entry pre'),'retains inspectable revision history');
 action('review-updated').click();await until(()=>document.getElementById('legacy-editor'),'review and update editor');
 form=document.getElementById('legacy-editor');form.elements.body_markdown.value='Reviewed updated message';form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
 await until(()=>action('review-no-change'),'reviewed item detail');
 check(fixtureCalls.some(call=>call.route.endsWith('/review')&&call.body.action==='updated'),'Reviewed and Updated saves the revision and review history');
 action('review-no-change').click();await flush();
 check(fixtureCalls.some(call=>call.route.endsWith('/review')&&call.body.action==='no_change')&&!fixtureCalls.some(call=>/deadswitch|checkin/.test(call.route)),'information reviews remain separate from Dead Man’s Switch check-in');
 action('back').click();await until(()=>workspace().querySelector('[data-legacy-group="family_history"]'),'content list');workspace().querySelector('[data-legacy-group="family_history"]').click();
 check(workspace().querySelector('.legacy-timeline')&&workspace().textContent.includes('Approx. 1985')&&workspace().textContent.includes('Unknown date'),'family timeline preserves approximate and unknown dates');
 workspace().querySelector('#legacy-search').value='family';workspace().querySelector('#legacy-from').value='1980-01-01';workspace().querySelector('#legacy-to').value='1990-12-31';workspace().querySelector('#legacy-filter-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));await flush();
 check(fixtureCalls.some(call=>call.route.includes('q=family')&&call.route.includes('from=1980-01-01')&&call.route.includes('to=1990-12-31')),'family search sends people or tag text and date filters');
 window.location.hash='beneficiaries';await until(()=>document.querySelector('[data-legacy-beneficiary]'),'existing beneficiaries view');
 document.querySelector('[data-legacy-beneficiary="1"]').open=true;await until(()=>document.querySelector('[data-legacy-recipient-items]').textContent.includes('A letter for Alex'),'recipient content summary');
 check(document.querySelector('[data-legacy-recipient-items]').textContent.includes('private')&&document.querySelector('[data-legacy-recipient-items]').textContent.includes('Household handover'),'beneficiary record shows its private and released content alongside existing access controls');
 document.querySelector('[href="#section/final_wishes/letter-1"]').click();await until(()=>action('edit')&&workspace().querySelector('.legacy-heading').textContent.includes('A letter for Alex'),'recipient-specific content management');
 check(!!action('edit'),'beneficiary content links open the existing Final Wishes editor and release controls');
 window.location.hash='beneficiaries';await until(()=>document.querySelector('[data-legacy-beneficiary="1"]'),'return to beneficiaries');document.querySelector('[data-legacy-beneficiary="1"]').open=true;await until(()=>document.querySelector('a[href*="new?type=letter"]'),'recipient authoring shortcuts');
 document.querySelector('a[href*="new?type=letter"]').click();await until(()=>document.getElementById('legacy-editor'),'recipient-specific new letter');
 check(document.getElementById('legacy-editor').elements.type.value==='letter'&&document.querySelectorAll('[name="beneficiary_ids"]:checked').length===1&&document.querySelector('[name="beneficiary_ids"]:checked').value==='1','beneficiary authoring shortcut prefills only that existing recipient');
 renderVaultReadonly({owner:{name:'Example owner',email:'owner@example.test'},beneficiary:{name:'Alex Example',relationship:'Child'},entries:[fixtureEntries[1]]},'synthetic-recipient-token');
 await until(()=>document.querySelector('[data-recipient-content]'),'protected beneficiary content');
 check(!document.getElementById('beneficiary-legacy-root').textContent.includes('A letter for Alex'),'recipient portal displays only server-authorised records');
 document.querySelector('[data-recipient-content]').click();await until(()=>document.querySelector('[data-legacy-step]'),'beneficiary instructions');
 check(document.querySelector('#beneficiary-legacy-root strong')&&!document.querySelector('#beneficiary-legacy-root img'),'recipient Markdown uses protected server rendering without tracking embeds');
 const step=document.querySelector('[data-legacy-step]');step.checked=true;step.dispatchEvent(new Event('change',{bubbles:true}));await flush();
 const acknowledgement=fixtureCalls.find(call=>call.route.endsWith('/acknowledgements'));
 check(acknowledgement.body.step_id==='water-garden'&&acknowledgement.body.acknowledged===true&&fixtureItems.find(item=>item.id==='instructions-1').metadata.checklist[0].text==='Water the garden','beneficiary checklist confirmation preserves canonical instructions');
 check(acknowledgement.headers.Authorization==='Bearer synthetic-recipient-token'&&!acknowledgement.route.includes('synthetic-recipient-token'),'beneficiary requests use existing token authentication without URL secrets');
 check(document.querySelector('[data-recipient-linked-entry="12"]'),'beneficiary instructions link to authorised vault records');
 document.querySelector('[data-legacy-file][data-mode="preview"]').click();await until(()=>document.querySelector('.doc-preview-body audio'),'authenticated media playback');
 check(document.querySelector('audio').src.startsWith('blob:')&&!document.querySelector('audio').src.includes('synthetic-recipient-token'),'recording playback uses a private blob URL');
 window.location.hash='login';await until(()=>document.getElementById('login-form'),'navigation cleanup');
 check(!document.querySelector('.doc-preview-overlay'),'navigation closes private playback and revokes its object URL');
 await originalFixtureFetch('/ui-test-result',{method:'POST',body:JSON.stringify({ok:true,checks})});
})().catch(async error=>{await originalFixtureFetch('/ui-test-result',{method:'POST',body:JSON.stringify({ok:false,error:error.message,stack:error.stack})});});
`;

test('Final Wishes authoring and protected beneficiary content work in Firefox', {
  timeout: 60000,
  skip: firefox ? false : 'Firefox not installed; set FIREFOX_BIN for browser acceptance',
}, async t => {
  const profiles=[];
  const browsers=[];
  let browserErrors='';
  let timer;
  let resolveResult;
  let rejectResult;
  const result=new Promise((resolve,reject)=>{resolveResult=resolve;rejectResult=reject;});
  const server=http.createServer((req,res)=>{
    if(req.url==='/ui-test-result'&&req.method==='POST'){
      let body='';req.on('data',chunk=>{body+=chunk;if(body.length>65536)req.destroy();});
      req.on('end',()=>{try{resolveResult(JSON.parse(body));res.end('ok');}catch(error){rejectResult(error);res.writeHead(400).end();}});return;
    }
    if(req.url==='/js/api.js'){res.setHeader('Content-Type','text/javascript');res.end(apiFixture);return;}
    if(req.url==='/'||req.url?.startsWith('/?screenshot=')){
      const screenshot=req.url.includes('screenshot=');
      const actualIndex=fs.readFileSync(path.join(publicRoot,'index.html'),'utf8');
      const recipientShot=req.url.includes('screenshot=recipient');
      res.setHeader('Content-Type','text/html');
      const checks=screenshot?(recipientShot?`<script>renderVaultReadonly({owner:{name:'Example owner',email:'owner@example.test'},beneficiary:{name:'Alex Example',relationship:'Child'},entries:[fixtureEntries[1]]},'synthetic-recipient-token');</script>`:''):`<script>${browserChecks}</script>`;
      res.end(actualIndex.replace('</body>',checks+'</body>'));return;
    }
    const pathname=String(req.url || '').split('?')[0];
    const file=path.resolve(publicRoot,'.'+pathname);
    if(!file.startsWith(publicRoot+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404).end();return;}
    res.setHeader('Content-Type',pathname.endsWith('.js')?'text/javascript':pathname.endsWith('.css')?'text/css':'application/octet-stream');res.end(fs.readFileSync(file));
  });
  t.after(async()=>{
    clearTimeout(timer);
    for(const browser of browsers){if(browser.exitCode===null){browser.kill('SIGTERM');await Promise.race([new Promise(resolve=>browser.once('close',resolve)),new Promise(resolve=>setTimeout(()=>{browser.kill('SIGKILL');resolve();},2000).unref())]);}}
    server.closeAllConnections();await new Promise(resolve=>server.close(resolve));profiles.forEach(profile=>fs.rmSync(profile,{recursive:true,force:true}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+server.address().port;
  function launch(args){const profile=fs.mkdtempSync(path.join(os.tmpdir(),'wolfs-legacy-ui-firefox-'));profiles.push(profile);const browser=spawn(firefox,['--headless','--no-remote','--profile',profile,...args],{stdio:['ignore','ignore','pipe']});browsers.push(browser);browser.stderr.on('data',chunk=>{browserErrors=(browserErrors+String(chunk)).slice(-2000);});return browser;}
  const browser=launch([origin+'/#section/final_wishes']);
  browser.once('error',rejectResult);browser.once('exit',code=>{if(code!==null&&code!==0)rejectResult(new Error('Firefox exited '+code+': '+browserErrors));});
  timer=setTimeout(()=>rejectResult(new Error('Firefox UI checks timed out: '+browserErrors)),40000);
  const report=await result;
  assert.equal(report.ok,true,[report.error,report.stack].filter(Boolean).join('\n'));
  assert.ok(report.checks.length>=25);
  t.diagnostic(report.checks.join('; '));
  if(process.env.LEGACY_UI_SCREENSHOT_DIR){
    const directory=path.resolve(process.env.LEGACY_UI_SCREENSHOT_DIR);fs.mkdirSync(directory,{recursive:true});
    for(const [name,route] of [['final-wishes-owner','owner#section/final_wishes'],['beneficiary-personal-content','recipient#access']]){
      const shot=launch(['--screenshot',path.join(directory,name+'.png'),'--window-size','1440,1250',origin+'/?screenshot='+route]);
      await new Promise((resolve,reject)=>{shot.once('error',reject);shot.once('exit',code=>code===0?resolve():reject(new Error('Screenshot browser exited '+code)));});
      assert.ok(fs.statSync(path.join(directory,name+'.png')).size>5000);
    }
  }
});
