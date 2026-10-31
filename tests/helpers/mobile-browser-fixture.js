'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

// Browser acceptance uses only these invented records, never the running vault.
const apiFixture = String.raw`
const NativeDate = Date;
Date = class extends NativeDate { constructor(...args) { super(...(args.length ? args : ['2026-10-29T10:00:00Z'])); } static now() { return new NativeDate('2026-10-29T10:00:00Z').getTime(); } };
const fixtureCalls = [];
const fixtureCopy = value => structuredClone(value);
const fixtureOwner = {id:1,name:'Example owner',email:'owner@example.test'};
const fixtureRecipients = [{id:1,name:'Alex Example',relationship:'Child',email:'alex@example.test',phone:'000 000 0000',access_granted:1,emergency_waiting_days:7,created_at:'2026-10-20T10:00:00Z'},{id:2,name:'Jamie Example',relationship:'Sibling',email:'jamie@example.test',access_granted:0,emergency_waiting_days:7,created_at:'2026-10-20T10:00:00Z'}];
const fixtureEntries = [
 {id:11,title:'Memorial arrangements',section:'final_wishes',fields:{category:'Memorial Preferences',details:'Gather together and share the stories that made us smile.',contact_person:'Family contact',contact_phone:'000 000 0000'},notes:''},
 {id:12,title:'Example family home',section:'real_estate',fields:{address:'42 Example Road, Example Town',contact:'Family contact'},notes:'Keep these instructions with the other household records.'},
 {id:13,title:'Example savings account',section:'bank_accounts',fields:{bank_name:'Example Bank',account_type:'Savings',account_number:'EXAMPLE-0000-1111-2222',nominee:'Alex Example',online_url:'https://example.test/accounts/'+ 'long-path-segment'.repeat(8),balance_approx:'R 12 345.67'},notes:'Synthetic browser testing record.'}
];
const fixtureCommon = {body_markdown:'A personal message for my family.',introduction:'',description:'',release_policy:'owner_only',status:'draft',beneficiary_ids:[1],metadata:{},links:[],beneficiaries:[],attachments:[],versions:[],reviews:[],release_events:[],review_enabled:false,revision:1,created_at:'2026-10-20T10:00:00Z',updated_at:'2026-10-28T10:00:00Z'};
const fixtureItems = [
 {...fixtureCopy(fixtureCommon),id:'letter-1',title:'A letter for Alex',type:'letter',description:'A private letter for a future birthday'},
 {...fixtureCopy(fixtureCommon),id:'memory-1',title:'Family picnic',type:'family_history',metadata:{event_date:'1985',date_precision:'approximate',people:['Alex Example'],tags:['family'],place:'Example park'}},
 {...fixtureCopy(fixtureCommon),id:'instructions-1',title:'Household handover',type:'instruction',body_markdown:'Check the garden each week.',status:'released',release_policy:'manual_release',review_enabled:true,review_interval_months:12,next_review_at:'2026-11-01T00:00:00Z',review_state:'due_soon',metadata:{category:'maintenance',priority:'normal',checklist:[{id:'water-garden',text:'Water the garden'},{id:'call-service',text:'Contact the maintenance service'}]},links:[{entry_id:12}],attachments:[{id:'recording-1',display_name:'Garden instructions and a personal message.wav',mime_type:'audio/wav',size_bytes:128,sha256:'a'.repeat(64)}],beneficiaries:[{beneficiary_id:1,name:'Alex Example',released_at:'2026-10-28T10:00:00Z',revoked_at:null,release_scope:'manual_release'}]}
];
function fixtureSync(item) { item.beneficiaries=item.beneficiary_ids.map(id=>item.beneficiaries?.find(row=>row.beneficiary_id===id)||{beneficiary_id:id,name:fixtureRecipients.find(recipient=>recipient.id===id).name,released_at:null,revoked_at:null});return item; }
fixtureItems.forEach(fixtureSync);
const fixtureNotification = {settings:{recipient:'owner@example.test',verified_at:'2026-10-28T12:00:00Z',reply_enabled:true,timezone:'Africa/Johannesburg',reminder_clock:null},cycle:{expiry_at:'2026-11-01T12:00:00Z',status:'open'},health:[],outbox:[],transport_configured:true,reply_transport_configured:true};
const fixtureHomebank = {config:{directory:'/example/homebank',selectedFile:'family.xhb'},source_file:'/example/homebank/family.xhb',source_saved_at:'2026-10-28T12:00:00Z',synced_at:'2026-10-28T12:01:00Z',stale:false,last_error:null,snapshot:{counts:{closed:0,excluded_open:0},total_transactions:2,accounts:[{name:'Example household savings account',type:'Bank',today:12345.67,reconciled:12000,cleared:12200,future:12345.67,currency:'ZAR',closed:false,excluded_from_summary:false,transaction_count:2,last_transaction:'2026-10-28',transactions:[{date:'2026-10-28',memo:'Example grocery and household purchase',amount:-123.45,status:1,balanceable:true},{date:'2026-10-27',memo:'Example monthly deposit',amount:2000,status:2,balanceable:true}]}]}};
const API = {
 token:'synthetic-owner-session',setToken(value){this.token=value;},
 async getMe(){return fixtureCopy(fixtureOwner);},
 async login(body){fixtureCalls.push({method:'login',body:fixtureCopy(body)});return {token:'synthetic-owner-session',user:fixtureCopy(fixtureOwner)};},
 async getSummary(){return ['final_wishes','real_estate','bank_accounts'].map(section=>({section,count:fixtureEntries.filter(entry=>entry.section===section).length}));},
 async getEntries(section){return {entries:fixtureCopy(fixtureEntries.filter(entry=>!section||entry.section===section)),pages:1};},
 async getEntry(id){return fixtureCopy(fixtureEntries.find(entry=>String(entry.id)===String(id)));},
 async createEntry(body){fixtureCalls.push({method:'createEntry',body:fixtureCopy(body)});const entry={...body,id:100};fixtureEntries.push(entry);return fixtureCopy(entry);},
 async updateEntry(id,body){fixtureCalls.push({method:'updateEntry',id,body:fixtureCopy(body)});const entry=fixtureEntries.find(row=>String(row.id)===String(id));Object.assign(entry,body);return fixtureCopy(entry);},
 async getBeneficiaries(){return fixtureCopy(fixtureRecipients);},
 async exportVault(){fixtureCalls.push({method:'exportVault'});return {owner:fixtureCopy(fixtureOwner),entries:fixtureCopy(fixtureEntries),exported_at:'2026-10-29T10:00:00Z'};},
 async addBeneficiary(body){fixtureCalls.push({method:'addBeneficiary',body:fixtureCopy(body)});fixtureRecipients.push({...body,id:3,created_at:'2026-10-29T10:00:00Z'});return {accessToken:'synthetic-recipient-token'};},
 async getSwitchStatus(){return {is_active:true,switch_triggered:false,is_overdue:false,last_check_in:'2026-10-28T10:00:00Z',next_check_in:'2026-11-28T10:00:00Z',grace_deadline:'2026-12-05T10:00:00Z',check_in_interval_days:30,grace_period_days:7};},
 async getAuditLog(){return {logs:[{created_at:'2026-10-28T10:00:00Z',action:'login',target_type:'owner',detail:'Synthetic owner session',ip_address:'192.0.2.1'}],page:1,pages:1};},
 async search(query){return fixtureCopy(fixtureEntries.filter(entry=>JSON.stringify(entry).toLowerCase().includes(decodeURIComponent(query).toLowerCase())));},
 async changePassword(body){fixtureCalls.push({method:'changePassword',body:fixtureCopy(body)});return {ok:true};},
 async accessVault(token){fixtureCalls.push({method:'accessVault',token});if(token!=='synthetic-recipient-token')throw new Error('Access denied');return {status:'granted',owner:fixtureCopy(fixtureOwner),beneficiary:fixtureCopy(fixtureRecipients[0]),entries:fixtureCopy([fixtureEntries[1]])};},
 async request(method,route,body){
  fixtureCalls.push({method,route,body:body?fixtureCopy(body):undefined});
  if(route==='/notifications')return fixtureCopy(fixtureNotification);
  if(route==='/notifications/settings')return {success:true};
  if(route==='/homebank/overview')return fixtureCopy(fixtureHomebank);
  if(route.startsWith('/homebank/files'))return {files:[{name:'family.xhb',mtime:'2026-10-28T12:00:00Z'}]};
  if(route==='/final-wishes/config')return {max_file_bytes:25*1024*1024,accepted:['.pdf','.png','.mp3','.m4a','.wav','.mp4','.mov']};
  if(route.startsWith('/vault/entries'))return {entries:fixtureCopy(fixtureEntries),pages:1};
  if(route==='/final-wishes/preview')return {html:'<p><strong>A personal message for my family.</strong></p>'};
  if(route.startsWith('/beneficiaries/'))return fixtureCopy(fixtureItems.filter(item=>item.beneficiary_ids.includes(Number(route.split('/')[2]))));
  if(route.startsWith('/final-wishes/legacy?')||(route==='/final-wishes/legacy'&&method==='GET'))return fixtureCopy(fixtureItems);
  if(route==='/final-wishes/legacy'&&method==='POST'){const item=fixtureSync({...fixtureCopy(fixtureCommon),...fixtureCopy(body),id:'created-item'});fixtureItems.push(item);return fixtureCopy(item);}
  const item=fixtureItems.find(row=>row.id===route.split('/')[3]);if(!item)throw new Error('Unhandled synthetic fixture route: '+route);
  if(method==='GET')return fixtureCopy(item);
  if(method==='PATCH'){Object.assign(item,body);item.revision++;fixtureSync(item);return fixtureCopy(item);}
  if(route.endsWith('/review')){item.reviews.push({action:body.action,created_at:'2026-10-29T10:00:00Z'});return fixtureCopy(item);}
  throw new Error('Unhandled synthetic fixture operation: '+method+' '+route);
 }
};
const fixtureOriginalFetch=window.fetch.bind(window);
window.fetch=async(url,options={})=>{
 const route=String(url);const headers={'Content-Type':'application/json'};
 if(!route.startsWith('/api/'))return fixtureOriginalFetch(url,options);
 fixtureCalls.push({method:options.method||'GET',route,headers:options.headers,body:typeof options.body==='string'?JSON.parse(options.body):undefined});
 if(route.startsWith('/api/documents/counts')||route.startsWith('/api/documents?'))return new Response('[]',{headers});
 if(route.startsWith('/api/beneficiary-access/legacy')){
  if(options.headers?.Authorization!=='Bearer synthetic-recipient-token')return new Response('{"error":"Access denied"}',{status:403,headers});
  const item=fixtureCopy(fixtureItems.find(row=>row.id==='instructions-1'));item.body_html='<p><strong>Check the garden each week.</strong></p>';item.acknowledgements=[];
  if(route.includes('/attachments/'))return new Response(new Uint8Array(128),{headers:{'Content-Type':'audio/wav'}});
  if(route.endsWith('/acknowledgements'))return new Response('{"ok":true}',{headers});
  return new Response(JSON.stringify(route==='/api/beneficiary-access/legacy'?[item]:item),{headers});
 }
 return new Response('{"error":"No live API is available in browser fixtures"}',{status:404,headers});
};
window.renderMobileRecipient=()=>renderVaultReadonly({owner:fixtureCopy(fixtureOwner),beneficiary:fixtureCopy(fixtureRecipients[0]),entries:fixtureCopy([fixtureEntries[1]])},'synthetic-recipient-token');
`;

async function createMobileFixtureServer({ publicRoot = path.resolve(__dirname, '../../public'), checks = '', onResult = () => {} } = {}) {
  const server = http.createServer((req, res) => {
    if (req.url === '/mobile-test-result' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; if (body.length > 262144) req.destroy(); });
      req.on('end', () => {
        try { onResult(JSON.parse(body)); res.end('ok'); }
        catch (error) { res.writeHead(400).end(error.message); }
      });
      return;
    }
    if (req.url === '/js/api.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(apiFixture); return; }
    if (req.url === '/' || req.url?.startsWith('/?')) {
      res.setHeader('Content-Type', 'text/html');
      const frameWidth = Number(new URL(req.url, 'http://fixture.invalid').searchParams.get('mobile-frame'));
      // Firefox's desktop chrome enforces a 500px minimum top-level window.
      // A same-origin frame gives its real rendering engine the exact phone viewport.
      if (Number.isInteger(frameWidth) && frameWidth >= 320 && frameWidth <= 1024) {
        res.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0"><iframe title="Synthetic mobile app browser acceptance" width="${frameWidth}" height="1000" style="border:0;display:block" src="/?fixture-frame=${frameWidth}#vault"></iframe></body></html>`);
        return;
      }
      res.end(fs.readFileSync(path.join(publicRoot, 'index.html'), 'utf8').replace('</body>', checks ? `<script>${checks}</script></body>` : '</body>'));
      return;
    }
    const pathname = String(req.url || '').split('?')[0];
    const file = path.resolve(publicRoot, '.' + pathname);
    if (!file.startsWith(publicRoot + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type', pathname.endsWith('.js') ? 'text/javascript' : pathname.endsWith('.css') ? 'text/css' : pathname.endsWith('.svg') ? 'image/svg+xml' : 'application/octet-stream');
    res.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { origin: `http://127.0.0.1:${server.address().port}`, close: async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}

// This function is serialized into Firefox or evaluated by optional browser tools.
async function runMobileWorkflow() {
  const checks = [];
  const check = (value, label) => { if (!value) throw new Error(label); checks.push(label); };
  const pause = () => new Promise(resolve => setTimeout(resolve, 30));
  const until = async (predicate, label) => { for (let n = 0; n < 150; n++) { if (predicate()) return; await pause(); } throw new Error('Timed out: ' + label); };
  const fits = label => check(document.documentElement.scrollWidth <= innerWidth + 1, label + ' fits the viewport');
  const route = async (hash, selector) => { location.hash = hash; await until(() => document.querySelector(selector), hash); await pause(); fits(hash); };
  const nav = () => document.getElementById('mobile-navigation');
  const toggle = () => document.getElementById('mobile-menu-toggle');
  const expanded = () => toggle()?.getAttribute('aria-expanded') === 'true';
  await until(() => document.querySelector('.vault-grid'), 'dashboard');
  check(innerWidth <= 1024, 'runs at a mobile or tablet viewport');
  fits('Dashboard');
  check(toggle() && !expanded() && nav()?.inert, 'closed drawer is unavailable to keyboard and assistive navigation');
  window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
  window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  toggle().click(); await until(expanded, 'open mobile navigation');
  check(!nav().inert, 'navigation remains usable after a page returns from the back and forward cache');
  check(nav().contains(document.activeElement), 'opening navigation moves focus into the drawer');
  check(document.querySelector('.main-content').inert, 'open drawer makes background content inert');
  const focusables = [...nav().querySelectorAll('button,input,a[href],[tabindex="0"]')].filter(el => el.getBoundingClientRect().height && !el.disabled);
  focusables[focusables.length - 1].focus();
  document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
  check(nav().contains(document.activeElement) && document.activeElement !== focusables[focusables.length - 1], 'Tab wraps from the last drawer control');
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await until(() => !expanded(), 'Escape closes navigation');
  check(document.activeElement === toggle() && !document.querySelector('.main-content').inert, 'Escape restores trigger focus and background interaction');
  toggle().click(); await until(expanded, 'open drawer for backdrop');
  document.querySelector('.mobile-nav-backdrop').click(); await until(() => !expanded(), 'backdrop closes drawer');
  check(nav().inert, 'backdrop closes and deactivates the drawer');
  toggle().click(); await until(expanded, 'open drawer for browser Back');
  const beforeBack = location.hash;
  history.back(); await until(() => !expanded(), 'browser Back closes drawer');
  check(location.hash === beforeBack && nav().inert, 'browser Back dismisses navigation without leaving the current page');
  toggle().click(); await until(expanded, 'open drawer for route');
  nav().querySelector('[data-nav="section/bank_accounts"]').click();
  await until(() => document.querySelector('[data-edit="13"]'), 'navigate to bank accounts');
  check(!expanded() && nav().inert, 'selecting a section closes navigation');
  fits('Bank account with a long URL');
  const sensitive = document.querySelector('.value.sensitive');
  check(sensitive && !sensitive.classList.contains('revealed'), 'sensitive bank fields remain concealed');
  sensitive.click(); check(sensitive.classList.contains('revealed'), 'tap reveals a sensitive bank field');
  document.getElementById('mobile-search-toggle').click(); await until(expanded, 'open mobile search');
  const search = document.getElementById('global-search');
  check(document.activeElement === search, 'mobile Search focuses the existing vault search input');
  search.value = 'example'; search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await until(() => location.hash === '#search/example' && document.querySelector('.page-header h1')?.textContent.includes('Search:'), 'search results');
  check(!expanded() && nav().inert, 'submitting mobile search closes its drawer');
  history.back(); await until(() => location.hash === '#section/bank_accounts' && document.querySelector('[data-edit="13"]'), 'Back from search');
  check(!expanded(), 'Back from search returns directly to the previous section');
  await route('edit/bank_accounts/13', '#entry-form');
  const entryForm = document.querySelector('#entry-form');
  entryForm.elements.title.value = 'Updated example savings account';
  entryForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await until(() => document.querySelector('[data-edit="13"]'), 'saved bank account');
  check(fixtureCalls.some(call => call.method === 'updateEntry' && call.body.title === 'Updated example savings account'), 'mobile entry form saves through the existing API');
  await route('section/final_wishes', '.legacy-tabs');
  check(!document.querySelector('#legacy-workspace [data-legacy-action="new"]'), 'Final Wishes provides a single page-level Add Final Wishes Entry action');
  document.querySelector('.page-header [data-nav="add/final_wishes"]').click();
  await until(() => location.hash === '#add/final_wishes' && document.querySelector('#legacy-editor'), 'unified Final Wishes entry form');
  const editor = document.querySelector('#legacy-editor');
  check(document.querySelector('.page-header h1').textContent === 'Add Final Wishes Entry' && editor.elements.type.value === 'instruction' && !document.querySelector('#entry-form'), 'mobile Add Final Wishes Entry opens the unified protected instructions editor');
  check(editor.elements.status.value === 'draft' && editor.elements.release_policy.value === 'owner_only', 'mobile authoring preserves private draft defaults');
  editor.elements.wish_category.value = 'Memorial Preferences';
  editor.elements.wish_details.value = 'Share family stories at the memorial.';
  editor.elements.wish_contact_person.value = 'Alex Example';
  editor.elements.wish_contact_phone.value = '000 000 0001';
  editor.elements.type.value = 'letter';
  editor.elements.type.dispatchEvent(new Event('change', { bubbles: true }));
  editor.querySelector('[name="beneficiary_ids"][value="1"]').checked = true;
  editor.querySelector('[name="link_ids"][value="12"]').checked = true;
  check(editor.querySelector('#doc-file-input').accept.includes('.mp4'), 'mobile authoring retains native media and document selection');
  const selected = new DataTransfer(); selected.items.add(new File(['synthetic recording'], 'Example family recording with a long descriptive filename.wav', { type: 'audio/wav' }));
  editor.querySelector('#doc-file-input').files = selected.files;
  editor.querySelector('#doc-file-input').dispatchEvent(new Event('change', { bubbles: true }));
  check(document.querySelector('#doc-queue').textContent.includes('Example family recording'), 'native file selection populates the managed copy queue');
  fits('Queued media filename');
  editor.querySelector('[data-remove-queued]').click();
  check(!editor.querySelector('[data-remove-queued]'), 'a selected recording can be removed before saving');
  editor.elements.title.value = 'Mobile family letter';
  editor.elements.body_markdown.value = 'A private message created on a phone.';
  editor.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await until(() => document.querySelector('[data-legacy-action="ready"]'), 'saved personal letter');
  check(fixtureCalls.some(call => call.method === 'POST' && call.route === '/final-wishes/legacy' && call.body.release_policy === 'owner_only'), 'mobile authoring saves without releasing private content');
  const savedWish = fixtureCalls.find(call => call.method === 'POST' && call.route === '/final-wishes/legacy');
  check(savedWish.body.type === 'letter' && savedWish.body.beneficiary_ids.includes(1) && savedWish.body.links.some(link => link.entry_id === 12) && savedWish.body.metadata.final_wishes.details === 'Share family stories at the memorial.' && savedWish.body.metadata.final_wishes.contact_person === 'Alex Example' && savedWish.body.metadata.final_wishes.contact_phone === '000 000 0001', 'mobile wishes retain arrangements, recipients and linked vault records in one protected record');
  check(!fixtureCalls.some(call => call.method === 'createEntry' && call.body.section === 'final_wishes') && location.hash === '#section/final_wishes/created-item', 'new mobile wishes avoid the ordinary vault create API and open their protected detail');
  await route('beneficiaries', '#add-ben-btn');
  document.querySelector('#add-ben-btn').click();
  await until(() => document.querySelector('#add-ben-form'), 'beneficiary dialog');
  fits('Beneficiary dialog');
  check(document.querySelector('.modal').getBoundingClientRect().width <= innerWidth, 'beneficiary dialog fits the phone');
  const rootStyle = document.documentElement.style;
  const previousHeight = rootStyle.getPropertyValue('--mobile-viewport-height');
  const previousTop = rootStyle.getPropertyValue('--mobile-viewport-top');
  rootStyle.setProperty('--mobile-viewport-height', '360px'); rootStyle.setProperty('--mobile-viewport-top', '40px');
  const modal = document.querySelector('.modal');
  let bounds = modal.getBoundingClientRect();
  check(bounds.top >= 40 && bounds.bottom <= 401, 'dialog stays within a simulated reduced visual viewport');
  modal.scrollTop = modal.scrollHeight;
  bounds = modal.getBoundingClientRect();
  const submitBounds = modal.querySelector('[type="submit"]').getBoundingClientRect();
  check(submitBounds.top >= bounds.top && submitBounds.bottom <= bounds.bottom + 1, 'dialog actions remain reachable by scrolling at reduced viewport height');
  showError('Synthetic reduced viewport feedback');
  const viewportToast = [...document.querySelectorAll('.toast')].find(el => el.textContent.includes('Synthetic reduced viewport feedback'));
  const toastBounds = viewportToast.getBoundingClientRect();
  check(toastBounds.top >= 40 && toastBounds.bottom <= 401, 'feedback remains within a simulated reduced visual viewport');
  viewportToast.remove();
  rootStyle.setProperty('--mobile-viewport-height', previousHeight); rootStyle.setProperty('--mobile-viewport-top', previousTop);
  document.querySelector('#close-modal').click();
  await route('homebank', '.hb-account');
  document.querySelector('.hb-account').open = true; fits('Expanded HomeBank account');
  check(document.querySelector('.hb-table-wrap').scrollWidth >= document.querySelector('.hb-table-wrap').clientWidth, 'HomeBank transactions keep a local scroll container');
  await route('settings', '#notification-title');
  check(document.querySelector('#notification-settings').textContent.includes('Email check-ins enabled'), 'notification settings retain verified email state');
  const inputs = [...document.querySelectorAll('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]),select,textarea')].filter(el => el.getBoundingClientRect().height && !el.closest('[inert]'));
  check(inputs.every(el => parseFloat(getComputedStyle(el).fontSize) >= 16), 'mobile text controls avoid iOS focus zoom');
  await route('vault', '#export-btn');
  const originalOpen = window.open; let opened = 0;
  window.open = () => { opened++; return null; };
  try { document.querySelector('#export-btn').click(); await until(() => document.querySelector('.mobile-export-overlay'), 'mobile export options'); }
  finally { window.open = originalOpen; }
  const openExport = document.querySelector('[data-export-open]');
  const saveExport = document.querySelector('[data-export-save]');
  check(opened === 0 && openExport?.href.startsWith('blob:') && saveExport?.href === openExport.href && saveExport.download, 'mobile export offers private Open and Save links without an asynchronous popup');
  fits('Export options');
  await route('access', '#access-form');
  check(!document.querySelector('.mobile-export-overlay'), 'navigation closes the private export options');
  const access = document.querySelector('#access-form');
  access.elements.token.value = 'synthetic-recipient-token';
  access.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await until(() => document.querySelector('[data-recipient-content]'), 'authorised beneficiary records');
  check(!document.querySelector('#beneficiary-legacy-root').textContent.includes('Mobile family letter'), 'beneficiary view keeps private author content unavailable');
  document.querySelector('[data-recipient-content]').click();
  await until(() => document.querySelector('[data-legacy-step]'), 'beneficiary checklist');
  const step = document.querySelector('[data-legacy-step]'); step.checked = true; step.dispatchEvent(new Event('change', { bubbles: true }));
  await until(() => fixtureCalls.some(call => call.route?.endsWith('/acknowledgements')), 'protected checklist confirmation');
  const acknowledgement = fixtureCalls.find(call => call.route?.endsWith('/acknowledgements'));
  check(acknowledgement.headers.Authorization === 'Bearer synthetic-recipient-token', 'beneficiary acknowledgements retain token authentication');
  document.querySelector('[data-legacy-file][data-mode="preview"]').click();
  await until(() => document.querySelector('.doc-preview-body audio'), 'private recording preview');
  fits('Recording preview');
  check(document.querySelector('audio').controls && document.querySelector('audio').src.startsWith('blob:'), 'private recording keeps native audio controls and blob URLs');
  document.querySelector('#close-doc-modal').click();
  Docs.preview(new Blob(['%PDF-1.4\n% synthetic browser fixture\n'], { type: 'application/pdf' }), 'Example family document.pdf', 'application/pdf');
  const pdfLinks = [...document.querySelectorAll('.doc-mobile-pdf-actions a')];
  check(pdfLinks.length === 2 && pdfLinks.every(link => link.href.startsWith('blob:')) && pdfLinks.some(link => link.target === '_blank') && pdfLinks.some(link => link.download), 'PDF preview offers private native browser Open and Save actions');
  fits('PDF preview');
  document.querySelector('#close-doc-modal').click();
  Docs.preview(new Blob(['synthetic video element fixture'], { type: 'video/mp4' }), 'Example family recording.mp4', 'video/mp4');
  const video = document.querySelector('.doc-preview-body video');
  check(video.controls && video.playsInline && !video.autoplay && video.src.startsWith('blob:'), 'video preview uses private inline controls without autoplay');
  check(video.getBoundingClientRect().width <= document.querySelector('.doc-preview-body').getBoundingClientRect().width, 'video preview stays within its mobile dialog');
  fits('Video preview');
  await route('login', '#login-form');
  check(!document.querySelector('.doc-preview-overlay'), 'navigation removes private media playback');
  check(!document.querySelector('.mobile-header'), 'owner navigation does not appear on login or beneficiary access');
  return checks;
}

module.exports = { apiFixture, createMobileFixtureServer, runMobileWorkflow };
