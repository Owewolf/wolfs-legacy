#!/usr/bin/env node
'use strict';

// Optional browser acceptance with invented data. Playwright is not a production
// dependency. Set PLAYWRIGHT_PACKAGE_PATH to an installed Playwright package.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createMobileFixtureServer } = require('../tests/helpers/mobile-browser-fixture');

const fixtureSetup = String.raw`
API.getSummary = async () => [...new Set(fixtureEntries.map(entry=>entry.section))].map(section=>({section,count:fixtureEntries.filter(entry=>entry.section===section).length}));
window.renderPetRecipient = () => renderVaultReadonly({owner:fixtureCopy(fixtureOwner),beneficiary:fixtureCopy(fixtureRecipients[0]),entries:fixtureCopy(fixtureEntries.filter(entry=>entry.section==='pet_care'))},'synthetic-recipient-token');
`;

// Serialized for Chromium and the optional host WebKitGTK runner.
async function runPetWorkflow() {
  const checks = [];
  const check = (value, label) => { if (!value) throw new Error(label); checks.push(label); };
  const pause = () => new Promise(resolve => setTimeout(resolve, 30));
  const until = async (predicate, label) => { for(let i=0;i<150;i++){if(predicate())return;await pause();}throw new Error('Timed out: '+label); };
  const fits = label => check(document.documentElement.scrollWidth <= innerWidth + 1, label+' fits the viewport');
  const route = async (hash, selector) => { location.hash=hash;await until(()=>document.querySelector(selector), hash);await pause(); };
  const sample = {
    pet_name:'Milo <the explorer>',species:'Dog',breed:'Mixed breed, tan and white',date_of_birth:'2021-05-04',microchip_number:'EXAMPLE-0000-1234',
    vet_name:'Example Veterinary Practice',vet_phone:'000 000 0000',vet_address:'42 Example Road, Example Town',
    dietary_needs:'One measured meal each morning and evening. Keep fresh water available.',medications:'Review the current written plan with the named vet before giving medication.',
    care_instructions:'A gentle walk each morning. Familiar blanket and toy help with settling.',preferred_carer:'Jamie Example',carer_phone:'000 000 0001',
    rehoming_plan:'Contact Jamie first. If unavailable, ask the named vet for a suitable local rescue contact.'
  };
  await until(()=>document.querySelector('.vault-grid'), 'dashboard');
  check(SECTIONS.pet_care.fields.length===14, 'Pet Care config exposes all 14 planned fields');
  const card = document.querySelector('.vault-card[data-nav="section/pet_care"]');
  check(card?.textContent.includes('Pet Care') && card.textContent.includes('0 entries'), 'dashboard shows an empty Pet Care card');
  check(document.querySelector('.nav-item[data-nav="section/pet_care"]'), 'sidebar lists Pet Care');
  fits('Dashboard');
  if(innerWidth<=1024){
    document.querySelector('#mobile-menu-toggle').click();
    await until(()=>document.querySelector('#mobile-menu-toggle').getAttribute('aria-expanded')==='true', 'open mobile menu');
    const nav = document.querySelector('#mobile-navigation');
    check(!nav.inert && nav.querySelector('[data-nav="section/pet_care"]').getBoundingClientRect().height>=44, 'mobile navigation exposes a touch-sized Pet Care item');
    nav.querySelector('[data-nav="section/pet_care"]').click();
  } else card.click();
  await until(()=>document.querySelector('.empty-state h3')?.textContent.includes('Pet Care'), 'Pet Care empty state');
  check(document.querySelector('.page-header h1')?.textContent.includes('Pet Care'), 'Pet Care has a dedicated section and empty state');
  fits('Empty Pet Care section');
  document.querySelector('.empty-state [data-nav="add/pet_care"]').click();
  await until(()=>document.querySelector('#entry-form'), 'new pet form');
  const form = document.querySelector('#entry-form');
  check(Object.keys(sample).every(key=>form.elements[key]), 'new entry form has every care, vet and carer field');
  check(form.elements.date_of_birth.type==='date' && form.elements.vet_phone.type==='tel' && form.elements.carer_phone.type==='tel', 'pet date and phone fields retain native mobile input types');
  check(form.querySelector('#doc-file-input')?.type==='file', 'Pet Care keeps the existing managed document picker');
  if(innerWidth<=1024) check([...form.querySelectorAll('input:not([type=hidden]):not([type=file]),textarea,select')].every(el=>parseFloat(getComputedStyle(el).fontSize)>=16), 'mobile Pet Care inputs use at least 16px text');
  fits('Pet Care entry form');
  form.elements.title.value='Milo care plan';
  form.elements.notes.value='Keep a familiar blanket & toy <comfort>.';
  Object.entries(sample).forEach(([key,value])=>{form.elements[key].value=value;});
  form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
  await until(()=>document.querySelector('[data-edit="100"]'), 'saved pet entry');
  const creation=fixtureCalls.find(call=>call.method==='createEntry');
  check(creation?.body.section==='pet_care' && Object.entries(sample).every(([key,value])=>creation.body.fields[key]===value), 'create submits all Pet Care fields through the existing entry API');
  check(document.querySelector('.main-content')?.textContent.includes('Milo <the explorer>') && !document.querySelector('the-explorer'), 'saved pet text is rendered as escaped content');
  check(Object.values(sample).every(value=>document.querySelector('.main-content').textContent.includes(value)), 'saved Pet Care card displays every field');
  fits('Saved Pet Care card');
  document.querySelector('[data-edit="100"]').click();
  await until(()=>document.querySelector('#entry-form'), 'edit pet');
  const editor=document.querySelector('#entry-form');
  check(Object.entries(sample).every(([key,value])=>editor.elements[key].value===value), 'edit form restores every stored Pet Care field');
  editor.elements.dietary_needs.value='Updated care plan: serve the usual measured meals in the familiar blue bowl.';
  editor.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
  await until(()=>document.querySelector('[data-edit="100"]'), 'updated pet');
  const updated=fixtureCalls.find(call=>call.method==='updateEntry'&&String(call.id)==='100');
  check(updated?.body.fields.dietary_needs.startsWith('Updated care plan:'), 'editing saves the updated care plan through the existing entry API');
  check(document.querySelector('.main-content').textContent.includes(updated.body.fields.dietary_needs), 'updated care plan is visible after saving');
  await route('vault', '.vault-grid');
  check(document.querySelector('.vault-card[data-nav="section/pet_care"]')?.textContent.includes('1 entry'), 'dashboard summary updates the Pet Care count after save');
  await route('access', '#access-form');
  window.renderPetRecipient();
  await until(()=>document.querySelector('#beneficiary-vault-entry-100'), 'read-only pet care');
  const readonly=document.querySelector('#beneficiary-vault-entry-100');
  check(document.querySelector('.section-title')?.textContent.includes('Pet Care'), 'beneficiary portal identifies the Pet Care section');
  check(SECTIONS.pet_care.fields.every(field=>readonly.textContent.includes(field.label)) && readonly.textContent.includes(updated.body.fields.dietary_needs), 'beneficiary read-only view shows every Pet Care label and current care plan');
  check(!readonly.querySelector('input,select,textarea,button,[data-edit],[data-delete]') && !document.querySelector('.sidebar'), 'beneficiary Pet Care view has no owner editing controls');
  fits('Beneficiary Pet Care view');
  return checks;
}

async function main() {
  const output=path.resolve(process.env.PET_BROWSER_OUTPUT_DIR||'/tmp/wolfs-vault-pet-care-browser-results');
  fs.mkdirSync(output,{recursive:true});
  const fixture=await createMobileFixtureServer({checks:fixtureSetup});
  const playwright=require(process.env.PLAYWRIGHT_PACKAGE_PATH||'playwright');
  const report={synthetic_data_only:true,engines:[],workflows:[],screenshots:[]};
  try {
    const browser=await playwright.chromium.launch({headless:true});
    report.engines.push({name:'chromium',version:browser.version()});
    try {
      for(const width of [390,820,1440]){
        const context=await browser.newContext({viewport:{width,height:width>=768?1100:844},deviceScaleFactor:1,isMobile:width<=1024,hasTouch:width<=1024,reducedMotion:'reduce'});
        await context.addInitScript(()=>localStorage.setItem('lv_theme','dark'));
        const page=await context.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));
        await page.goto(fixture.origin+'/#vault');
        const checks=await page.evaluate(runPetWorkflow);
        assert.deepEqual(errors,[],`Chromium ${width}px has no unhandled browser errors`);
        report.workflows.push({engine:'chromium',width,checks});
        await page.waitForFunction(()=>!document.querySelector('.toast'),null,{timeout:8000});
        if(width===390){
          await page.evaluate(()=>document.fonts.ready);await page.waitForTimeout(150);
          const filename='pet-care-beneficiary-390.png';await page.screenshot({path:path.join(output,filename),fullPage:true,animations:'disabled'});report.screenshots.push({engine:'chromium',width,view:'beneficiary',file:filename});
        }
        await page.evaluate(()=>{location.hash='#section/pet_care';});
        await page.waitForSelector('[data-edit="100"]');
        if(width===820){await page.locator('[data-edit="100"]').first().click();await page.waitForSelector('#entry-form');}
        await page.evaluate(()=>document.fonts.ready);await page.waitForTimeout(150);
        const filename=`pet-care-${width===820?'form':'owner'}-${width}.png`;await page.screenshot({path:path.join(output,filename),fullPage:true,animations:'disabled'});report.screenshots.push({engine:'chromium',width,view:width===820?'form':'owner',file:filename});
        assert.deepEqual(errors,[],`Chromium ${width}px captures have no unhandled browser errors`);
        await context.close();
        process.stdout.write(`Chromium ${width}px: ${checks.length} Pet Care checks passed\n`);
      }
    } finally {await browser.close();}
    if(process.env.PET_TEST_SYSTEM_WEBKIT!=='0'){
      const manifest=path.join(output,'system-webkit-manifest.json');
      fs.writeFileSync(manifest,JSON.stringify({origin:fixture.origin,output,phase:'pet-care',widths:[390],screens:[],theme:'dark',workflow:runPetWorkflow.toString()}));
      await new Promise((resolve,reject)=>{const child=spawn(process.env.PYTHON_BIN||'python3',[path.join(__dirname,'test-mobile-webkit.py'),manifest],{stdio:'inherit'});child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(new Error('System WebKit runner exited '+code)));});
      const webkit=JSON.parse(fs.readFileSync(path.join(output,'system-webkit-report.json'),'utf8'));report.engines.push(...webkit.engines);report.workflows.push(...webkit.screens);
    }
    fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2)+'\n');
    process.stdout.write(`Saved synthetic Pet Care evidence to ${output}\n`);
  } finally {await fixture.close();}
}

main().catch(error=>{process.stderr.write(error.stack+'\n');process.exitCode=1;});
