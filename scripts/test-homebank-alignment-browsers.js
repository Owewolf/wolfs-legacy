#!/usr/bin/env node
'use strict';

// Optional acceptance against invented accounts and an ephemeral frontend server.
// Playwright is external tooling, not a production dependency.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createMobileFixtureServer } = require('../tests/helpers/mobile-browser-fixture');

const fixtureSetup = String.raw`
const alignmentChecking = id => ({id,section:'bank_accounts',title:'Example current account',notes:'',homebank_account_id:id,
 fields:{bank_name:'Example Bank',account_type:'Current / Checking',homebank_group:'Bank Accounts',account_number:'EXAMPLE-'+id,balance_approx:'ZAR 1234.56',nominee:'Alex Example',owner_reference:'Keep this owner reference'},
 homebank_managed_fields:['bank_name','account_type','homebank_group','account_number','balance_approx','notes']});
const alignmentRetirement = id => ({id,section:'retirement',title:'Example retirement annuity',notes:'',homebank_account_id:id,
 fields:{provider:'Example Retirement Provider',type:'Annuity',homebank_group:'Retirement Annuity',account_number:'EXAMPLE-'+id,value_approx:'ZAR 6789.01',investment_type:'Owner balanced fund',beneficiary:'Alex Example',owner_reference:'Keep this owner reference'},
 homebank_managed_fields:['provider','type','homebank_group','account_number','value_approx','notes']});
fixtureEntries.splice(0,fixtureEntries.length,alignmentChecking(201),
 {id:202,section:'vehicles',title:'Example vehicle asset',notes:'',homebank_account_id:202,
  fields:{homebank_group:'Vehicles',make_model:'Example hatchback',current_value:'ZAR 85000.00',loan_balance:'ZAR 5000.00',loan_provider:'Owner finance provider',registration:'EXAMPLE-202',owner_reference:'Keep this owner reference'},
  homebank_managed_fields:['homebank_group','current_value','notes']},alignmentRetirement(203),alignmentRetirement(204),alignmentChecking(205));
API.getSummary=async()=>[...new Set(fixtureEntries.map(entry=>entry.section))].map(section=>({section,count:fixtureEntries.filter(entry=>entry.section===section).length}));
// Emulate the server contract: the source decides the current section and its
// managed values; an old bank draft's owner nominee maps into its new form.
API.updateEntry=async(id,body)=>{
 fixtureCalls.push({method:'updateEntry',id,body:fixtureCopy(body)});
 const entry=fixtureEntries.find(row=>String(row.id)===String(id));
 const fields=fixtureCopy(body.fields);
 if(body.section==='bank_accounts'&&entry.section==='retirement'){
  if(fields.nominee)fields.beneficiary=fields.nominee;
  delete fields.nominee;
 }
 const source=Object.fromEntries(entry.homebank_managed_fields.filter(key=>key!=='notes').map(key=>[key,entry.fields[key]]));
 entry.title=body.title;entry.fields={...fields,...source};
 return fixtureCopy(entry);
};
window.reclassifyAlignmentAccount=()=>{
 const entry=fixtureEntries.find(row=>row.id===205);
 Object.assign(entry,alignmentRetirement(205),{title:entry.title});
};
`;

// Serialized for Chromium and the optional host WebKitGTK runner.
async function runAlignmentWorkflow() {
  const checks = [];
  const check = (value, label) => { if (!value) throw new Error(label); checks.push(label); };
  const pause = () => new Promise(resolve => setTimeout(resolve, 25));
  const until = async (predicate, label) => { for(let i=0;i<180;i++){if(predicate())return;await pause();}throw new Error('Timed out: '+label); };
  const fits = label => check(document.documentElement.scrollWidth <= innerWidth + 1, label+' fits the viewport');
  const route = async (hash, selector) => {
    location.hash=hash;
    await until(()=>location.hash==='#'+hash&&document.querySelector(selector), hash);
    await pause();
  };
  const submit = form => form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
  await until(()=>document.querySelector('.vault-grid'), 'dashboard');
  fits('Dashboard');

  await route('edit/vehicles/202','#entry-form [name=current_value]');
  let form=document.querySelector('#entry-form');
  check(form.elements.current_value.readOnly&&form.elements.current_value.value==='ZAR 85000.00', 'vehicle assets show the source valuation as read-only current value');
  check(!form.elements.loan_balance.readOnly&&form.elements.loan_balance.value==='ZAR 5000.00', 'vehicle loan balance remains a separate editable owner detail');
  check(!form.elements.loan_provider.readOnly&&form.elements.loan_provider.value==='Owner finance provider', 'asset custodian does not overwrite the owner loan provider');
  check(form.elements.homebank_group.readOnly&&form.elements.homebank_group.value==='Vehicles', 'vehicle form exposes the source group');
  fits('Vehicle form');
  if(window.captureAlignment&&innerWidth===390)await window.captureAlignment('vehicle-form');
  form.elements.loan_balance.value='ZAR 4200.00';
  form.elements.registration.value='UPDATED-EXAMPLE-202';
  submit(form);
  await until(()=>location.hash==='#section/vehicles'&&document.querySelector('[data-edit="202"]'), 'saved vehicle');
  const vehicleSave=fixtureCalls.find(call=>call.method==='updateEntry'&&String(call.id)==='202');
  check(vehicleSave.body.fields.loan_balance==='ZAR 4200.00'&&vehicleSave.body.fields.registration==='UPDATED-EXAMPLE-202', 'vehicle save retains edited loan and registration fields');
  check(!Object.hasOwn(vehicleSave.body.fields,'current_value')&&!Object.hasOwn(vehicleSave.body.fields,'homebank_group'), 'vehicle save omits source-managed values');
  check(vehicleSave.body.fields.owner_reference==='Keep this owner reference', 'saving preserves owner fields outside the displayed schema');
  check(document.querySelector('.main-content').textContent.includes('ZAR 85000.00')&&document.querySelector('.main-content').textContent.includes('ZAR 4200.00'), 'saved vehicle card labels valuation and loan values separately');

  await route('edit/bank_accounts/201','#entry-form [name=account_type]');
  form=document.querySelector('#entry-form');
  check(form.elements.account_type.tagName==='INPUT'&&form.elements.account_type.readOnly&&form.elements.account_type.value==='Current / Checking', 'current account renders its exact source type in a read-only control');
  check(form.elements.bank_name.readOnly&&form.elements.bank_name.value==='Example Bank', 'checking form uses current source institution metadata');
  check(form.elements.homebank_group.readOnly&&form.elements.homebank_group.value==='Bank Accounts', 'checking form exposes the correct source group');
  check(!form.elements.nominee.readOnly&&form.elements.nominee.value==='Alex Example', 'checking nominee remains editable');
  fits('Checking form');

  await route('edit/retirement/203','#entry-form [name=investment_type]');
  form=document.querySelector('#entry-form');
  check(form.elements.type.readOnly&&form.elements.type.value==='Annuity', 'retirement group renders the source Annuity classification');
  check(form.elements.provider.readOnly&&form.elements.provider.value==='Example Retirement Provider', 'retirement form uses the source provider');
  check(form.elements.homebank_group.readOnly&&form.elements.homebank_group.value==='Retirement Annuity', 'retirement form exposes the source retirement group');
  check(!form.elements.investment_type.readOnly&&form.elements.investment_type.value==='Owner balanced fund', 'underlying investment remains separate and editable');
  check(!form.elements.beneficiary.readOnly&&form.elements.beneficiary.value==='Alex Example', 'retirement beneficiary remains editable');
  fits('Retirement form');
  if(innerWidth<=1024)check([...form.querySelectorAll('input:not([type=hidden]):not([type=file]),textarea,select')].every(el=>parseFloat(getComputedStyle(el).fontSize)>=16), 'financial form text controls use at least 16px on mobile');
  if(window.captureAlignment&&innerWidth!==390)await window.captureAlignment('retirement-form');

  location.hash='edit/bank_accounts/204';
  await until(()=>location.hash==='#edit/retirement/204'&&document.querySelector('#entry-form [name=provider]'), 'stale bank edit redirects');
  form=document.querySelector('#entry-form');
  check(document.querySelector('.page-header h1').textContent.includes('Retirement Accounts'), 'stale bank edit opens the current retirement category');
  check(form.elements.investment_type&&form.elements.beneficiary&&!form.elements.bank_name, 'stale edit renders the retirement schema after fetching the current record');
  fits('Redirected retirement form');

  await route('edit/bank_accounts/205','#entry-form [name=nominee]');
  form=document.querySelector('#entry-form');
  form.elements.title.value='Unsaved owner title';
  form.elements.nominee.value='Unsaved owner nominee';
  form.elements.nominee.focus();
  window.reclassifyAlignmentAccount();
  await refreshLiveVault();
  const banner=document.querySelector('#homebank-reclassification');
  check(banner?.getAttribute('role')==='status'&&banner.textContent.includes('Retirement Accounts'), 'live category change announces the new section');
  check(document.querySelector('#entry-form')===form&&form.elements.title.value==='Unsaved owner title'&&form.elements.nominee.value==='Unsaved owner nominee', 'live refresh preserves the active form and unsaved owner draft');
  check(location.hash==='#edit/bank_accounts/205', 'live category change keeps the current draft open until save');
  fits('Reclassification notice');
  form.elements.nominee.blur();
  if(window.captureAlignment&&innerWidth===390)await window.captureAlignment('classification-change');
  submit(form);
  await until(()=>location.hash==='#section/retirement'&&document.querySelector('[data-edit="205"]'), 'saved reclassified draft');
  const changedSave=fixtureCalls.find(call=>call.method==='updateEntry'&&String(call.id)==='205');
  check(changedSave.body.title==='Unsaved owner title'&&changedSave.body.fields.nominee==='Unsaved owner nominee', 'reclassified save submits the owner draft without dropping edits');
  check(changedSave.body.fields.owner_reference==='Keep this owner reference', 'reclassified save preserves undisplayed owner fields');
  const savedCard=document.querySelector('[data-edit="205"]').closest('.card');
  check(savedCard?.textContent.includes('Unsaved owner title')&&savedCard.textContent.includes('Unsaved owner nominee'), 'saved retirement card displays the server-mapped owner details');
  check(savedCard.textContent.includes('Annuity')&&savedCard.textContent.includes('Example Retirement Provider'), 'saved retirement card displays the current classification and provider');
  check(document.querySelector('.page-header h1').textContent.includes('Retirement Accounts'), 'save response chooses the current category landing page');
  fits('Saved retirement section');
  return checks;
}

async function main() {
  const output=path.resolve(process.env.HOMEBANK_ALIGNMENT_BROWSER_OUTPUT_DIR||'/tmp/wolfs-vault-homebank-alignment-browser-results');
  fs.mkdirSync(output,{recursive:true});
  const fixture=await createMobileFixtureServer({checks:fixtureSetup});
  const playwright=require(process.env.PLAYWRIGHT_PACKAGE_PATH||'playwright');
  const report={synthetic_data_only:true,physical_devices_tested:false,engines:[],workflows:[],screenshots:[]};
  try {
    const browser=await playwright.chromium.launch({headless:true});
    report.engines.push({name:'chromium',version:browser.version()});
    try {
      for(const width of [390,820,1440]){
        const context=await browser.newContext({viewport:{width,height:width>=768?1100:844},deviceScaleFactor:1,isMobile:width<=1024,hasTouch:width<=1024,reducedMotion:'reduce'});
        await context.addInitScript(()=>localStorage.setItem('lv_theme','dark'));
        const page=await context.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));
        await page.exposeFunction('captureAlignment',async view=>{
          await page.evaluate(()=>{
            document.activeElement?.blur();
            document.querySelectorAll('.toast').forEach(toast=>toast.remove());
            window.scrollTo(0,0);
          });
          await page.evaluate(()=>document.fonts.ready);await page.waitForTimeout(100);
          const filename=`${view}-${width}.png`;
          await page.screenshot({path:path.join(output,filename),fullPage:true,animations:'disabled'});
          report.screenshots.push({engine:'chromium',width,view,file:filename});
        });
        await page.goto(fixture.origin+'/#vault');
        const checks=await page.evaluate(runAlignmentWorkflow);
        assert.deepEqual(errors,[],`Chromium ${width}px has no unhandled browser errors`);
        report.workflows.push({engine:'chromium',width,checks});
        await context.close();
        process.stdout.write(`Chromium ${width}px: ${checks.length} HomeBank alignment checks passed\n`);
      }
    } finally {await browser.close();}
    if(process.env.HOMEBANK_ALIGNMENT_TEST_SYSTEM_WEBKIT!=='0'){
      const manifest=path.join(output,'system-webkit-manifest.json');
      fs.writeFileSync(manifest,JSON.stringify({origin:fixture.origin,output,phase:'homebank-alignment',widths:[390],screens:[],theme:'dark',workflow:runAlignmentWorkflow.toString()}));
      await new Promise((resolve,reject)=>{
        const child=spawn(process.env.PYTHON_BIN||'python3',[path.join(__dirname,'test-mobile-webkit.py'),manifest],{stdio:'inherit'});
        child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(new Error('System WebKit runner exited '+code)));
      });
      const webkit=JSON.parse(fs.readFileSync(path.join(output,'system-webkit-report.json'),'utf8'));
      report.engines.push(...webkit.engines);report.workflows.push(...webkit.screens);
    }
    fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2)+'\n');
    process.stdout.write(`Saved synthetic HomeBank alignment evidence to ${output}\n`);
  } finally {await fixture.close();}
}

main().catch(error=>{process.stderr.write(error.stack+'\n');process.exitCode=1;});
