'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const firefox = [process.env.FIREFOX_BIN, '/usr/bin/firefox', '/usr/bin/firefox-esr']
  .filter(Boolean).find(file => { try { fs.accessSync(file, fs.constants.X_OK); return true; } catch { return false; } });
const publicRoot = path.join(__dirname, '..', 'public');

// The actual application runs against an in-memory fixture. No vault, database,
// hosting credentials or real recipient is accessed by these destructive checks.
const fixture = `
const fixtureCalls=[],fixturePrompts=[];
let fixtureConfirm=true;
window.confirm=message=>{fixturePrompts.push(message);return fixtureConfirm;};
const fixtureItems=['cancel','delete','failure','detail','archive','archived-list','archived-detail'].map(id=>({
 id,type:'instruction',title:'Synthetic wish '+id,status:id.startsWith('archived-')?'archived':'draft',
 release_policy:'owner_only',body_markdown:'',metadata:{final_wishes:{content_type:''}},
 beneficiaries:[],beneficiary_ids:[],attachments:[],links:[],versions:[],reviews:[],release_events:[],
 review_enabled:false,created_at:'2026-11-02T10:00:00Z',updated_at:'2026-11-02T10:00:00Z'
}));
const fixtureCopy=value=>structuredClone(value);
const API={
 token:'synthetic-owner',setToken(value){this.token=value;},
 async getMe(){return {id:1,name:'Synthetic owner',email:'owner@example.test'};},
 async getEntries(){return {entries:[],pages:1};},async getSummary(){return [];},async getBeneficiaries(){return [];},
 async request(method,route,body){
  fixtureCalls.push({method,route,body:body?fixtureCopy(body):undefined});
  if(route==='/final-wishes/config')return {max_file_bytes:1024,accepted:['.txt']};
  if(route==='/final-wishes/preview')return {html:'<p>Example message</p>'};
  if(route==='/final-wishes/legacy'||route.startsWith('/final-wishes/legacy?')){
   const query=new URLSearchParams(route.split('?')[1] || '');
   return fixtureCopy(fixtureItems.filter(item=>!query.get('status')||item.status===query.get('status')));
  }
  const id=decodeURIComponent(route.split('/')[3]),index=fixtureItems.findIndex(item=>item.id===id),item=fixtureItems[index];
  if(!item)throw new Error('Synthetic wish not found');
  if(method==='GET')return fixtureCopy(item);
  if(method==='DELETE'){
   if(body?.confirm_delete!==true)throw new Error('Permanent deletion confirmation required');
   if(id==='failure')throw new Error('Synthetic deletion failed');
   fixtureItems.splice(index,1);return {ok:true};
  }
  if(method==='PATCH'){Object.assign(item,body);return fixtureCopy(item);}
  throw new Error('Unhandled synthetic route: '+method+' '+route);
 }
};
const fixtureFetch=window.fetch.bind(window);
window.fetch=async(url,options)=>String(url).startsWith('/api/documents/counts')?new Response('[]',{headers:{'Content-Type':'application/json'}}):fixtureFetch(url,options);
`;

const checks = `
(async()=>{
 const checks=[];
 const check=(value,label)=>{if(!value)throw new Error(label);checks.push(label);};
 const flush=()=>new Promise(resolve=>setTimeout(resolve,25));
 const until=async(predicate,label)=>{for(let i=0;i<160;i++){if(predicate())return;await flush();}throw new Error('Timed out: '+label);};
 const root=()=>document.querySelector('#legacy-workspace');
 const action=(name,id)=>root()?.querySelector('[data-legacy-action="'+name+'"]'+(id?'[data-item-id="'+id+'"]':''));
 const card=id=>action('delete',id)?.closest('.record-card');
 const count=()=>document.querySelector('.sidebar [data-nav="section/final_wishes"] .count')?.textContent || '0';
 const deletes=id=>fixtureCalls.filter(call=>call.method==='DELETE'&&(!id||call.route.endsWith('/'+id)));
 await until(()=>root()?.querySelector('.legacy-list')&&count()==='5','initial owner list');
 check(root().querySelectorAll('[data-legacy-action="delete"]').length===7,'active and archived owner cards all offer permanent deletion');
 fixtureConfirm=false;action('delete','cancel').click();await flush();
 check(deletes().length===0&&card('cancel')&&!action('delete','cancel').disabled,'cancelling confirmation leaves the wish and sends no deletion');
 check(/Permanently delete/.test(fixturePrompts[0])&&/history/.test(fixturePrompts[0])&&/not shared/.test(fixturePrompts[0])&&/cannot be undone/.test(fixturePrompts[0]),'confirmation explains permanent wish, history and unshared-file deletion');
 fixtureConfirm=true;action('delete','failure').click();
 await until(()=>root()?.querySelector('[data-legacy-feedback]')?.textContent==='Synthetic deletion failed','visible deletion failure');
 check(card('failure')&&!action('delete','failure').disabled&&!card('failure').hasAttribute('aria-busy'),'failed deletion retains the card and restores its controls');
 action('delete','delete').click();await until(()=>!card('delete')&&count()==='4','active list deletion and refreshed count');
 check(deletes('delete').length===1&&deletes('delete')[0].body.confirm_delete===true&&location.hash==='#section/final_wishes'&&card('cancel'),'confirmed active list deletion sends the explicit permanent-delete flag, refreshes counts and keeps unrelated wishes');
 root().querySelector('#legacy-filter-status').value='archived';
 root().querySelector('#legacy-filter-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
 await until(()=>root()?.querySelectorAll('.legacy-item').length===2,'archived list');
 action('delete','archived-list').click();await until(()=>!card('archived-list')&&card('cancel'),'permanent archived list deletion');
 check(!fixtureItems.some(item=>item.id==='archived-list')&&deletes('archived-list').length===1,'archived wishes can be permanently deleted from the list');
 location.hash='section/final_wishes/archived-detail';
 await until(()=>root()?.querySelector('.legacy-detail')&&action('delete','archived-detail'),'archived detail');
 check(!action('archive')&&action('delete','archived-detail'),'archived owner detail offers Delete without another Archive action');
 action('preview').click();await until(()=>root()?.textContent.includes('Owner preview of the recipient'),'recipient preview');
 check(!action('delete')&&!action('archive'),'recipient preview omits permanent deletion and archive controls');
 action('open').click();await until(()=>action('delete','archived-detail'),'return to owner detail');
 action('delete','archived-detail').click();
 await until(()=>location.hash==='#section/final_wishes'&&root()?.querySelector('.legacy-list')&&!card('archived-detail'),'archived detail deletion');
 check(deletes('archived-detail').length===1&&!fixtureItems.some(item=>item.id==='archived-detail'),'archived detail deletion returns to the list and removes its record');
 location.hash='section/final_wishes/detail';await until(()=>root()?.querySelector('.legacy-detail')&&action('delete','detail'),'active detail');
 action('delete','detail').click();await until(()=>location.hash==='#section/final_wishes'&&root()?.querySelector('.legacy-list')&&count()==='3','active detail deletion');
 check(!fixtureItems.some(item=>item.id==='detail')&&deletes('detail').length===1,'active detail deletion returns to the list with current counts');
 location.hash='section/final_wishes/archive';await until(()=>root()?.querySelector('.legacy-detail')&&action('archive'),'archive control');
 action('archive').click();await until(()=>location.hash==='#section/final_wishes'&&root()?.querySelector('.legacy-list')&&count()==='2','archive status update');
 check(fixtureItems.find(item=>item.id==='archive')?.status==='archived'&&fixtureCalls.some(call=>call.method==='PATCH'&&call.route.endsWith('/archive')&&call.body.status==='archived')&&deletes('archive').length===0,'Archive preserves the wish through PATCH and never calls permanent DELETE');
 await fixtureFetch('/delete-ui-result',{method:'POST',body:JSON.stringify({ok:true,checks})});
})().catch(async error=>{await fixtureFetch('/delete-ui-result',{method:'POST',body:JSON.stringify({ok:false,error:error.message,stack:error.stack})});});
`;

test('owners can permanently delete active and archived Final Wishes without using Archive', {
  timeout: 45000,
  skip: firefox ? false : 'Firefox not installed; set FIREFOX_BIN for browser acceptance',
}, async t => {
  let resolveResult, rejectResult, timer, browser;
  const result = new Promise((resolve, reject) => { resolveResult=resolve; rejectResult=reject; });
  const profile=fs.mkdtempSync(path.join(os.tmpdir(),'wolfs-delete-ui-'));
  const server=http.createServer((req,res)=>{
    if(req.url==='/delete-ui-result'&&req.method==='POST'){
      let body='';req.on('data',chunk=>{body+=chunk;if(body.length>32768)req.destroy();});
      req.on('end',()=>{try{resolveResult(JSON.parse(body));res.end('ok');}catch(error){rejectResult(error);res.writeHead(400).end();}});return;
    }
    if(req.url==='/js/api.js'){res.setHeader('Content-Type','text/javascript');res.end(fixture);return;}
    if(req.url==='/'){res.setHeader('Content-Type','text/html');res.end(fs.readFileSync(path.join(publicRoot,'index.html'),'utf8').replace('</body>','<script>'+checks+'</script></body>'));return;}
    const pathname=String(req.url || '').split('?')[0],file=path.resolve(publicRoot,'.'+pathname);
    if(!file.startsWith(publicRoot+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404).end();return;}
    res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'application/octet-stream');res.end(fs.readFileSync(file));
  });
  t.after(async()=>{
    clearTimeout(timer);
    if(browser&&browser.exitCode===null){browser.kill('SIGTERM');await Promise.race([new Promise(resolve=>browser.once('close',resolve)),new Promise(resolve=>setTimeout(()=>{browser.kill('SIGKILL');resolve();},2000).unref())]);}
    server.closeAllConnections();await new Promise(resolve=>server.close(resolve));fs.rmSync(profile,{recursive:true,force:true});
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  let browserErrors='';
  browser=spawn(firefox,['--headless','--no-remote','--profile',profile,'http://127.0.0.1:'+server.address().port+'/#section/final_wishes'],{stdio:['ignore','ignore','pipe']});
  browser.stderr.on('data',chunk=>{browserErrors=(browserErrors+chunk).slice(-2000);});browser.once('error',rejectResult);
  timer=setTimeout(()=>rejectResult(new Error('Deletion UI checks timed out: '+browserErrors)),35000);
  const report=await result;
  assert.equal(report.ok,true,[report.error,report.stack].filter(Boolean).join('\n'));
  assert.equal(report.checks.length,11);
  t.diagnostic(report.checks.join('; '));
});
