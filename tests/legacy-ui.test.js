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
const fixtureRecipients=[{id:1,name:'Alex Example',relationship:'Child',email:'alex@example.test',phone:'000 000 0001',access_granted:1,emergency_waiting_days:7,created_at:'2026-10-20T10:00:00Z'},{id:2,name:'Jamie Example',relationship:'Sibling',access_granted:0,emergency_waiting_days:7,created_at:'2026-10-20T10:00:00Z'}];
const fixtureEntries=[{id:11,title:'Memorial arrangements',section:'final_wishes',fields:{category:'Memorial Preferences',details:'Existing final wish retained',contact_person:'Family contact',contact_phone:'000 000 0000'},notes:''},{id:12,title:'Example family home',section:'real_estate',fields:{address:'Example address'},notes:''},{id:1,title:'Estate adviser',section:'contacts',fields:{name:'Casey <Adviser>',role:'Lawyer',email:'lawyer@example.test',phone:'000 000 0013'},notes:''}];
const common={body_markdown:'A personal message',introduction:'',description:'',release_policy:'owner_only',status:'draft',beneficiary_ids:[1],metadata:{},links:[],beneficiaries:[],attachments:[],versions:[],reviews:[],release_events:[],review_enabled:false,revision:1,created_at:'2026-10-20T10:00:00Z',updated_at:'2026-10-28T10:00:00Z'};
const fixtureItems=[
{...structuredClone(common),id:'plain-1',auto_generated:true,locked_beneficiary:{id:1,name:'Alex Example'},title:'Alex Example',type:'instruction',body_markdown:'',metadata:{final_wishes:{content_type:'',category:'Beneficiary Instructions',details:'',contact_person:'',contact_phone:'',notes:''}},review_interval_months:6,next_review_at:null,last_reviewed_at:'2026-10-20T10:00:00Z',reviews:[{action:'disabled',created_at:'2026-10-20T10:00:00Z'}]},
{...structuredClone(common),id:'letter-1',title:'A letter for Alex',type:'letter',description:'A private letter for a future birthday'},
{...structuredClone(common),id:'recording-2',title:'A recorded family story',type:'recording'},
{...structuredClone(common),id:'memory-1',title:'Family picnic',type:'family_history',metadata:{event_date:'1985',date_precision:'approximate',people:['Alex Example'],tags:['family'],place:'Example park'}},
{...structuredClone(common),id:'memory-2',title:'An undated photograph',type:'family_history',metadata:{date_precision:'unknown',people:['Jamie Example']}},
{...structuredClone(common),id:'review-1',title:'Review estate information',type:'review',review_enabled:true},
{...structuredClone(common),id:'instructions-1',title:'Household handover',type:'instruction',body_markdown:'Check the garden each week.',status:'released',release_policy:'manual_release',review_enabled:true,review_interval_months:12,next_review_at:'2026-11-01T00:00:00Z',review_state:'due_soon',metadata:{custom_owner_note:'Retain this metadata',final_wishes:{custom_detail:'Retain this wish detail',contact_recipients:[{entry_id:99,name:'Saved former contact'}]},category:'maintenance',priority:'normal',checklist:[{id:'water-garden',text:'Water the garden'},{id:'call-service',text:'Contact the maintenance service'}]},links:[{entry_id:12}],attachments:[{id:'recording-1',display_name:'Garden instructions.wav',mime_type:'audio/wav',size_bytes:128,sha256:'a'.repeat(64)}],beneficiaries:[{beneficiary_id:1,name:'Alex Example',released_at:'2026-10-28T10:00:00Z',revoked_at:null,release_scope:'manual_release'}]}
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
 async createEntry(body){fixtureCalls.push({method:'createEntry',body:fixtureCopy(body)});throw new Error('New Final Wishes must use the protected content API');},
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
 const searchRecipients=query=>{const input=document.getElementById('legacy-recipient-search');input.value=query;input.dispatchEvent(new Event('input',{bubbles:true}));return input;};
 await until(()=>workspace()?.querySelector('.legacy-list'),'owner content list');
 check(!workspace().querySelector('.legacy-tabs,[data-legacy-group]'),'Final Wishes list has no separate content category buttons');
 check(fixtureItems.every(item=>workspace().querySelector('.legacy-list').textContent.includes(item.title)),'one Final Wishes list displays letters, recordings, family history, instructions and reviews');
 check(document.querySelector('.final-wishes-entries').textContent.includes('Existing final wish retained'),'preserves existing Final Wishes fields and arrangements');
 check(!Array.from(document.querySelectorAll('.sidebar .nav-item')).some(item=>item.textContent.includes('Personal Legacy')),'adds no top-level legacy section');
 check(document.querySelectorAll('.page-header [data-nav="add/final_wishes"]').length===1&&!action('new')&&!workspace().querySelector('.legacy-heading'),'Final Wishes list has one page-level Add Final Wishes Entry action');
 window.location.hash='section/final_wishes/plain-1';await until(()=>action('edit')&&workspace().querySelector('.legacy-heading')?.textContent.includes('Alex Example'),'beneficiary-created plain wish');
 check(workspace().querySelector('.record-category-chip')?.textContent==='Beneficiary Instructions'&&!action('review-no-change')&&!workspace().textContent.includes('Review history'),'plain beneficiary wish has a normal Final Wishes card without information reviews');
 action('edit').click();await until(()=>document.getElementById('legacy-editor'),'plain beneficiary wish editor');
 let plainForm=document.getElementById('legacy-editor');
 check(plainForm.elements.title.value==='Alex Example'&&plainForm.querySelector('[data-locked-beneficiary="1"]')&&plainForm.elements.type.value===''&&plainForm.elements.wish_category.value==='Beneficiary Instructions'&&['wish_details','wish_contact_person','wish_contact_phone','wish_notes','description','introduction','body_markdown'].every(name=>plainForm.elements[name].value==='')&&!plainForm.elements.category&&!plainForm.elements.priority&&plainForm.querySelector('#legacy-review-fields').hidden,'beneficiary-created wish has its name, recipient and Beneficiary Instructions category populated with other content blank');
 check(!plainForm.querySelector('#legacy-recipient-search,[data-add-recipient],[data-remove-recipient]'),'automatic wish has a locked recipient without recipient search or selection controls');
 plainForm.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));await until(()=>action('edit')&&!document.getElementById('legacy-editor'),'saved plain wish');
 const plainSave=fixtureCalls.find(call=>call.method==='PATCH'&&call.route==='/final-wishes/legacy/plain-1');
 check(plainSave.body.type==='instruction'&&plainSave.body.metadata.final_wishes.content_type===''&&plainSave.body.metadata.final_wishes.category==='Beneficiary Instructions'&&!plainSave.body.metadata.category&&!plainSave.body.metadata.priority&&plainSave.body.review_enabled===false&&plainSave.body.review_interval_months===6&&plainSave.body.next_review_at===null&&!action('review-no-change'),'plain wish save preserves compatible storage and hidden review settings without adding defaults');
 action('back').click();await until(()=>workspace().querySelector('.legacy-list'),'return to normal wishes');
 document.querySelector('.page-header [data-nav="add/final_wishes"]').click();
 await until(()=>document.getElementById('legacy-editor'),'unified Final Wishes editor');
 let form=document.getElementById('legacy-editor');
 check(location.hash==='#add/final_wishes'&&document.querySelector('.page-header h1').textContent==='Add Final Wishes Entry','page-level action opens the unified Final Wishes form');
 check(workspace().contains(form)&&!document.getElementById('entry-form')&&form.elements.type.value===''&&form.querySelector('#legacy-review-fields').hidden&&!form.elements.category&&!form.elements.priority,'new wishes use one blank protected editor without an optional content type or information reviews');
 check(form.elements.wish_category.value===''&&Array.from(form.elements.wish_category.options).some(option=>option.value==='Beneficiary Instructions'&&option.textContent==='Beneficiary Instructions'),'generic new wish category stays blank and offers Beneficiary Instructions');
 check(['letter','recording','family_history','instruction','review'].every(type=>Array.from(form.querySelector('#legacy-type').options).some(option=>option.value===type)),'the unified entry editor retains every content type');
 check(form.elements.release_policy.value==='owner_only'&&form.elements.status.value==='draft','new content defaults to private draft');
 form.elements.type.value='review';form.elements.type.dispatchEvent(new Event('change',{bubbles:true}));
 check(!form.querySelector('#legacy-review-fields').hidden,'choosing Information Reviews explicitly offers review scheduling');
 form.elements.review_enabled.checked=true;form.elements.review_enabled.dispatchEvent(new Event('change',{bubbles:true}));
 form.elements.wish_category.value='Memorial Preferences';
 form.elements.wish_details.value='Share family stories at the memorial.';
 form.elements.wish_contact_person.value='Alex Example';
 form.elements.wish_contact_phone.value='000 000 0001';
 form.elements.type.value='letter';form.elements.type.dispatchEvent(new Event('change',{bubbles:true}));
 check(form.elements.wish_details.value==='Share family stories at the memorial.','changing content group preserves the Final Wishes arrangements');
 check(form.querySelector('#doc-file-input').accept.includes('.mp4')&&form.querySelector('#doc-drop').tabIndex===0,'reuses accessible managed document picker and drop area for media');
 form.elements.title.value='<img src=x onerror="window.fixtureInjected=true"> Letter for family';
 form.elements.body_markdown.value='# Message\\n**Family**';
 form.elements.release_policy.value='manual_release';
 check(!form.querySelector('[name="beneficiary_ids"]')&&!form.querySelector('[name="link_ids"]')&&!form.textContent.includes('Related vault records')&&form.querySelectorAll('#legacy-recipient-results button').length===3,'recipients offer every saved beneficiary and contact immediately without a checklist or related vault selection');
 let recipientSearch=searchRecipients('alex@example.test');
 check(form.querySelector('[data-add-recipient="beneficiary:1"]')&&form.querySelectorAll('#legacy-recipient-results button').length===1,'beneficiary search matches a saved email');
 recipientSearch=searchRecipients('000 000 0001');
 check(form.querySelector('[data-add-recipient="beneficiary:1"]'),'beneficiary search matches a saved phone');
 recipientSearch=searchRecipients('');recipientSearch.focus();
 check(form.querySelectorAll('#legacy-recipient-results button').length===3,'focusing or clearing recipient search always offers all saved people');
 recipientSearch=searchRecipients('lawyer@example.test');
 check(form.querySelector('[data-add-recipient="contact:1"]').textContent.includes('Casey <Adviser>')&&form.querySelector('[data-add-recipient="contact:1"]').textContent.includes('no vault access')&&!form.querySelector('[data-add-recipient="contact:1"] img'),'contact search matches email and safely labels named-only access');
 recipientSearch=searchRecipients('Lawyer');recipientSearch.focus();recipientSearch.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true}));
 check(document.activeElement.dataset.addRecipient==='contact:1','Arrow Down moves from search to the matching recipient button');
 document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
 check(document.activeElement===recipientSearch&&form.querySelectorAll('#legacy-recipient-results button').length===3,'Escape clears the query and offers saved people again with focus on search');
 recipientSearch=searchRecipients('000 000 0013');recipientSearch.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
 check(form.querySelector('[data-remove-recipient="contact:1"]')&&form.querySelectorAll('#legacy-recipient-results button').length===2,'Enter chooses a contact found by phone and continues offering unselected saved people');
 searchRecipients('Alex').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
 searchRecipients('Sibling');form.querySelector('[data-add-recipient="beneficiary:2"]').click();
 check(form.querySelector('[data-remove-recipient="contact:1"]')&&form.querySelector('[data-remove-recipient="beneficiary:1"]')&&form.querySelectorAll('[name="beneficiary_ids"]').length===2,'contacts and beneficiaries keep separate IDs and can be selected together');
 form.querySelector('[data-remove-recipient="contact:1"]').click();
 check(!form.querySelector('[data-remove-recipient="contact:1"]')&&document.activeElement===recipientSearch,'selected recipient removal returns focus to search');
 searchRecipients('Lawyer');form.querySelector('[data-add-recipient="contact:1"]').click();
 check([...form.querySelectorAll('[data-add-recipient],[data-remove-recipient]')].every(control=>control.getBoundingClientRect().height>=44),'recipient picker controls keep accessible touch targets');
 action('markdown-preview').click();await until(()=>!document.getElementById('legacy-editor-preview').hidden,'Markdown preview');
 const rendered=document.getElementById('legacy-editor-preview');
 check(!!rendered.querySelector('strong')&&!rendered.querySelector('img,script,iframe')&&!rendered.querySelector('a[href]')&&!window.fixtureInjected,'Markdown preview keeps formatting and removes executable HTML, unsafe links and remote tracking');
 form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
 await until(()=>action('ready'),'saved draft detail');
 const create=fixtureCalls.find(call=>call.method==='POST'&&call.route==='/final-wishes/legacy');
 check(create.body.beneficiary_ids.length===2&&create.body.metadata.final_wishes.contact_recipients.length===1&&create.body.metadata.final_wishes.contact_recipients[0].entry_id===1&&create.body.metadata.final_wishes.contact_recipients[0].name==='Casey <Adviser>'&&create.body.links.length===0,'one protected wish names contacts alongside beneficiaries without linking unrelated vault records');
 check(create.body.type==='letter'&&create.body.metadata.final_wishes.category==='Memorial Preferences'&&create.body.metadata.final_wishes.details==='Share family stories at the memorial.'&&create.body.metadata.final_wishes.contact_person==='Alex Example'&&create.body.metadata.final_wishes.contact_phone==='000 000 0001','unified authoring saves arrangements and selected content group in the protected record');
 check(!fixtureCalls.some(call=>call.method==='createEntry')&&location.hash==='#section/final_wishes/created-item','new wishes save only through the protected API and open their detail route');
 check(workspace().querySelector('.record-category-chip')?.textContent==='Memorial Preferences'&&Array.from(workspace().querySelectorAll('.legacy-detail .record-category-chip')).length===1&&!Array.from(workspace().querySelectorAll('.legacy-metadata dt')).some(label=>label.textContent==='Wish category'),'saved wish category appears once in the card heading');
 check(!workspace().querySelector('img')&&!window.fixtureInjected&&workspace().textContent.includes('<img src=x'),'escapes personal content titles in management');
 check(workspace().querySelector('.legacy-recipients').textContent.includes('Casey <Adviser>')&&workspace().querySelector('.legacy-recipients').textContent.includes('no vault access'),'wish details distinguish named contacts from access recipients');
 action('ready').click();await until(()=>action('release'),'ready item detail');
 action('release').click();
 let dialog=document.querySelector('[aria-labelledby="legacy-release-dialog"]');
 check(dialog&&dialog.querySelectorAll('[name="release_ids"]').length===2&&!dialog.textContent.includes('Casey <Adviser>')&&!dialog.querySelector('[name="confirmed"]').checked&&!fixtureCalls.some(call=>call.route.endsWith('/release')),'manual release waits for explicit confirmation');
 dialog.querySelector('[name="confirmed"]').checked=true;
 dialog.querySelector('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
 await until(()=>action('revoke'),'released item detail');
 check(fixtureCalls.some(call=>call.route.endsWith('/release')&&call.body.confirm===true&&call.body.beneficiary_ids.length===2),'confirmed release targets selected existing beneficiaries');
 action('preview').click();await until(()=>workspace().textContent.includes('Owner preview of the recipient'),'recipient preview');
 check(!action('release')&&!workspace().textContent.includes('Revision history')&&workspace().textContent.includes('Casey <Adviser>'),'recipient preview shows named contacts with the content without owner management history');
 action('open').click();await until(()=>action('edit'),'return to management');action('edit').click();
 await until(()=>document.getElementById('legacy-editor'),'released content editor');
 check(workspace().textContent.includes('clears previous releases')&&document.getElementById('legacy-editor').elements.status.value==='draft','editing released content explains and defaults to a new draft');
 check(document.getElementById('legacy-editor').elements.wish_details.value==='Share family stories at the memorial.','protected content edits retain the saved Final Wishes arrangements');
 form=document.getElementById('legacy-editor');form.elements.body_markdown.value='Updated message';form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
 await until(()=>action('ready'),'updated draft detail');
 check(workspace().textContent.includes('Revision history (')&&workspace().querySelector('.legacy-history-entry pre'),'retains inspectable revision history');
 action('review-updated').click();await until(()=>document.getElementById('legacy-editor'),'review and update editor');
 form=document.getElementById('legacy-editor');form.elements.body_markdown.value='Reviewed updated message';form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
 await until(()=>action('review-no-change'),'reviewed item detail');
 check(fixtureCalls.some(call=>call.route.endsWith('/review')&&call.body.action==='updated'),'Reviewed and Updated saves the revision and review history');
 action('review-no-change').click();await flush();
 check(fixtureCalls.some(call=>call.route.endsWith('/review')&&call.body.action==='no_change')&&!fixtureCalls.some(call=>/deadswitch|checkin/.test(call.route)),'information reviews remain separate from Dead Man’s Switch check-in');
 action('back').click();await until(()=>workspace().querySelector('.legacy-list'),'content list');
 const familyDates=Array.from(workspace().querySelectorAll('.legacy-timeline-date')).map(element=>element.textContent);
 check(familyDates.includes('Approx. 1985')&&familyDates.includes('Unknown date'),'family history cards preserve approximate and unknown dates in the shared list');
 check(!workspace().querySelector('#legacy-from,#legacy-to,.legacy-timeline'),'the shared list has no separate family timeline or date range controls');
 workspace().querySelector('#legacy-search').value='family';workspace().querySelector('#legacy-filter-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));await flush();
 check(fixtureCalls.some(call=>call.route.includes('q=family')),'shared Final Wishes search sends people or tag text');
 check(workspace().querySelector('.legacy-list').textContent.includes('Casey <Adviser>'),'wish cards show contact recipient names alongside beneficiaries');
 window.location.hash='section/final_wishes/instructions-1';await until(()=>action('edit')&&workspace().textContent.includes('Household handover'),'existing linked wish');
 check(workspace().querySelector('a[href="#edit/real_estate/12"]'),'existing related records remain available in read-only detail');
 action('edit').click();await until(()=>document.getElementById('legacy-editor'),'existing linked wish editor');form=document.getElementById('legacy-editor');
 check(form.querySelector('[data-remove-recipient="contact:99"]')?.getAttribute('aria-label').includes('Saved former contact')&&!form.querySelector('[name="link_ids"]'),'editing retains a deleted contact snapshot and hides vault record selection');
 form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));await until(()=>action('ready'),'saved existing linked wish');
 const linkedEdit=fixtureCalls.find(call=>call.method==='PATCH'&&call.route==='/final-wishes/legacy/instructions-1'&&call.body.metadata);
 check(linkedEdit.body.links.length===1&&linkedEdit.body.links[0].entry_id===12&&linkedEdit.body.metadata.custom_owner_note==='Retain this metadata'&&linkedEdit.body.metadata.final_wishes.custom_detail==='Retain this wish detail'&&linkedEdit.body.metadata.final_wishes.contact_recipients[0].name==='Saved former contact','editing preserves historical links, deleted contact names and unknown metadata');
 window.location.hash='beneficiaries';await until(()=>document.querySelector('[data-legacy-beneficiary]'),'existing beneficiaries view');
 document.querySelector('[data-legacy-beneficiary="1"]').open=true;await until(()=>document.querySelector('[data-legacy-recipient-items]').textContent.includes('A letter for Alex'),'recipient content summary');
 check(document.querySelector('[data-legacy-recipient-items]').textContent.includes('private')&&document.querySelector('[data-legacy-recipient-items]').textContent.includes('Household handover'),'beneficiary record shows its private and released content alongside existing access controls');
 document.querySelector('[href="#section/final_wishes/letter-1"]').click();await until(()=>action('edit')&&workspace().querySelector('.legacy-heading').textContent.includes('A letter for Alex'),'recipient-specific content management');
 check(!!action('edit'),'beneficiary content links open the existing Final Wishes editor and release controls');
 window.location.hash='beneficiaries';await until(()=>document.querySelector('[data-legacy-beneficiary="1"]'),'return to beneficiaries');document.querySelector('[data-legacy-beneficiary="1"]').open=true;await until(()=>document.querySelector('a[href="#add/final_wishes?type=letter&beneficiary_id=1"]'),'recipient authoring shortcuts');
 document.querySelector('a[href="#add/final_wishes?type=letter&beneficiary_id=1"]').click();await until(()=>document.getElementById('legacy-editor'),'recipient-specific new letter');
 check(document.getElementById('legacy-editor').elements.type.value==='letter'&&document.getElementById('legacy-editor').elements.title.value==='Alex Example'&&document.getElementById('legacy-editor').elements.wish_category.value==='Beneficiary Instructions'&&document.querySelectorAll('[name="beneficiary_ids"]').length===1&&document.querySelector('[name="beneficiary_ids"]').value==='1','beneficiary authoring shortcut prefills only that existing recipient');
 window.location.hash='section/final_wishes/new?type=recording&beneficiary_id=2';
 await until(()=>location.hash==='#add/final_wishes?type=recording&beneficiary_id=2'&&document.getElementById('legacy-editor')?.elements.type.value==='recording','legacy authoring shortcut redirects to the unified form');
 check(document.querySelectorAll('[name="beneficiary_ids"]').length===1&&document.querySelector('[name="beneficiary_ids"]').value==='2','legacy authoring route retains its chosen content group and beneficiary');
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
