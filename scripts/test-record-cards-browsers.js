#!/usr/bin/env node
'use strict';

// Optional browser acceptance using invented, in-memory records only. No running
// vault, configured database, or HomeBank file is read. Playwright is external
// tooling and is intentionally not a production dependency.
// PLAYWRIGHT_PACKAGE_PATH=/absolute/path/to/playwright node scripts/test-record-cards-browsers.js
// RECORD_CARDS_PUBLIC_ROOT=/tmp/baseline/public RECORD_CARDS_PHASE=baseline captures the old UI.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createMobileFixtureServer } = require('../tests/helpers/mobile-browser-fixture');

const output = path.resolve(process.env.RECORD_CARDS_OUTPUT_DIR || '/tmp/wolfs-vault-record-cards-browser-results');
const publicRoot = path.resolve(process.env.RECORD_CARDS_PUBLIC_ROOT || path.join(__dirname, '../public'));
const phase = process.env.RECORD_CARDS_PHASE || 'after';
const widths = (process.env.RECORD_CARDS_WIDTHS || '320,390,820,1122,1440').split(',').map(Number);
const themes = (process.env.RECORD_CARDS_THEMES || 'dark,light').split(',');
const engine = process.env.RECORD_CARDS_ENGINE || 'chromium';

const fixtureSetup = String.raw`
const cardFixtureValue = (section, field) => {
 if(field.options) return field.options.includes('Annuity') ? 'Annuity' : field.options[0];
 if(field.type==='date') return '1988-04-21';
 if(/value|balance|outstanding|premium|assured|payment/.test(field.key)) return 'ZAR 9876543.210000';
 if(/url/.test(field.key)) return 'https://example.test/private/'+'long-unbroken-segment'.repeat(7);
 if(field.type==='textarea') return 'Synthetic '+section+' '+field.key+'\nSecond line with <private & unchanged> content.';
 return 'Synthetic '+section+' '+field.key+' <private & unchanged>';
};
const cardFixtureAllEntries=Object.entries(SECTIONS).filter(([,schema])=>!schema.retired).map(([section,schema],index)=>({
 id:501+index,section,title:'Synthetic '+schema.name+' record with a deliberately long account name '+ 'UnbrokenAccountName'.repeat(3),
 fields:Object.fromEntries(schema.fields.map(field=>[field.key,cardFixtureValue(section,field)])),
 notes:'Synthetic private notes for '+section+'.\nPreserve this second line and <escaped & unchanged> characters.'
}));
const cardFixtureRetirementEntries=[
 // Fully invented illustrations preserve the design scenarios without copying
 // names, providers or balances from the user's private reference images.
 {id:701,section:'retirement',title:'Example crypto portfolio',fields:{provider:'Example Estate',homebank_group:'Retirement Annuity',type:'Annuity',investment_type:'Cryptocurrency',value_approx:'ZAR 12345.67'},notes:''},
 {id:702,section:'retirement',title:'Example retirement account',fields:{provider:'Example Retirement Provider',homebank_group:'Retirement Annuity',type:'Annuity',value_approx:'ZAR 234567.89'},notes:''},
 {id:703,section:'retirement',title:'Example investment annuity',fields:{provider:'Example Retirement Provider',homebank_group:'Retirement Annuity',type:'Annuity',investment_type:'Other',value_approx:'ZAR 3456789.01'},notes:''}
];
const cardFixtureCounts=new Map(cardFixtureAllEntries.map((entry,index)=>[entry.id,index%3]));
cardFixtureRetirementEntries.forEach(entry=>cardFixtureCounts.set(entry.id,0));
window.setRecordCardFixtures=kind=>fixtureEntries.splice(0,fixtureEntries.length,...fixtureCopy(kind==='reference'?cardFixtureRetirementEntries:kind==='empty'?[]:cardFixtureAllEntries));
window.setRecordCardFixtures('all');
API.getSummary=async()=>Object.keys(SECTIONS).map(section=>({section,count:fixtureEntries.filter(entry=>entry.section===section).length}));
API.deleteEntry=async id=>{
 fixtureCalls.push({method:'deleteEntry',id});
 if(window.cardFixtureDeletePending) await new Promise(resolve=>{window.releaseRecordCardDeletion=resolve;});
 if(window.cardFixtureDeleteFails){window.cardFixtureDeleteFails=false;throw new Error('Synthetic deletion refused');}
 const index=fixtureEntries.findIndex(entry=>String(entry.id)===String(id));
 if(index>=0)fixtureEntries.splice(index,1);
 return {success:true};
};
const cardFixtureFetch=window.fetch;
window.fetch=async(url,options={})=>{
 const route=String(url);
 if(route.startsWith('/api/documents/counts')){
  const section=new URL(route,location.origin).searchParams.get('section');
  fixtureCalls.push({method:options.method||'GET',route});
  return new Response(JSON.stringify(fixtureEntries.filter(entry=>entry.section===section).map(entry=>({entry_id:entry.id,count:cardFixtureCounts.get(entry.id)||0}))),{headers:{'Content-Type':'application/json'}});
 }
 if(route.startsWith('/api/documents?')){
  const id=Number(new URL(route,location.origin).searchParams.get('entryId'));
  fixtureCalls.push({method:options.method||'GET',route});
  const documents=Array.from({length:cardFixtureCounts.get(id)||0},(_,index)=>({id:'synthetic-document-'+id+'-'+index,display_name:'Synthetic document '+(index+1)+'.pdf',mime_type:'application/pdf',size_bytes:42}));
  return new Response(JSON.stringify(documents),{headers:{'Content-Type':'application/json'}});
 }
 return cardFixtureFetch(url,options);
};
window.renderRecordCardRecipient=()=>renderVaultReadonly({owner:fixtureCopy(fixtureOwner),beneficiary:fixtureCopy(fixtureRecipients[0]),entries:fixtureCopy(cardFixtureAllEntries)},'synthetic-recipient-token');
window.recordCardFixtureSnapshot=()=>({entries:fixtureCopy(fixtureEntries),all:fixtureCopy(cardFixtureAllEntries),counts:Object.fromEntries(cardFixtureCounts),calls:fixtureCopy(fixtureCalls)});
if(new URLSearchParams(location.search).get('screen')==='retirement-reference')window.setRecordCardFixtures('reference');
`;

async function openSection(page, origin, section, fixtureKind = 'all') {
  await page.goto(origin + '/?record-card-fixture=' + fixtureKind + '#vault');
  await page.waitForSelector('.vault-grid');
  await page.evaluate(kind => window.setRecordCardFixtures(kind), fixtureKind);
  await page.evaluate(sectionKey => { location.hash = 'section/' + sectionKey; }, section);
  await page.waitForSelector(fixtureKind === 'empty' ? '.empty-state' : '.main-content [data-edit]');
  await page.evaluate(() => document.fonts.ready);
}

async function screenshot(page, report, name, width, theme) {
  await page.evaluate(() => {
    document.activeElement?.blur();
    document.querySelectorAll('.toast').forEach(toast => toast.remove());
    window.scrollTo(0, 0);
  });
  const file = `${phase}-${engine}-${name}-${theme}-${width}.png`;
  await page.screenshot({ path: path.join(output, file), fullPage: true, animations: 'disabled' });
  report.screenshots.push({ name, theme, width, file });
}

// Runs against the actual rendered frontend, checking data preservation and
// viewport fit for every schema rather than seeding or touching persisted data.
async function checkAllSectionCards(page, width) {
  return page.evaluate(async viewportWidth => {
    const checks = [];
    const check = (value, label) => { if (!value) throw new Error(label); checks.push(label); };
    const pause = () => new Promise(resolve => setTimeout(resolve, 20));
    const until = async (predicate, label) => {
      for (let n = 0; n < 200; n++) { if (predicate()) return; await pause(); }
      throw new Error('Timed out: ' + label);
    };
    for (const entry of window.recordCardFixtureSnapshot().all) {
      location.hash = 'section/' + entry.section;
      await until(() => document.querySelector(`.record-card [data-edit="${entry.id}"]`), entry.section);
      const card = document.querySelector(`.record-card [data-edit="${entry.id}"]`).closest('.record-card');
      const header = card.querySelector('.record-card-header');
      const footer = card.querySelector('.record-card-footer');
      check(card.tagName === 'ARTICLE' && !!header?.querySelector('h3'), entry.section + ': semantic card and heading');
      check(header.querySelector('h3').textContent === entry.title, entry.section + ': complete title unchanged');
      check(!!header.querySelector('svg.record-icon use') && !header.querySelector('button'), entry.section + ': contextual icon precedes information without actions');
      const svg = header.querySelector('svg.record-icon');
      check(!!(svg.compareDocumentPosition(header.querySelector('h3')) & Node.DOCUMENT_POSITION_FOLLOWING), entry.section + ': icon is before title');
      await until(() => [...card.querySelectorAll('svg.record-icon use')].every(use => use.getBBox().width > 0 && use.getBBox().height > 0), entry.section + ': external SVG icons render');
      check([...card.querySelectorAll('svg.record-icon use')].every(use => use.getBBox().width > 0), entry.section + ': title and action icons render from the SVG sprite');
      for (const field of SECTIONS[entry.section].fields) {
        const item = [...card.querySelectorAll('.record-details .field-item')].find(candidate => candidate.textContent.includes(field.label));
        check(!!item && item.querySelector('.value')?.textContent === entry.fields[field.key], entry.section + ': preserves ' + field.key);
      }
      check(card.textContent.includes(entry.notes), entry.section + ': notes including line breaks preserved');
      const buttons = [...card.querySelectorAll('[data-edit],[data-delete]')];
      check(buttons.length === 3 && buttons.every(button => footer.contains(button) && button.type === 'button'), entry.section + ': three real footer buttons');
      const docCount = window.recordCardFixtureSnapshot().counts[entry.id] || 0;
      check(buttons.some(button => button.textContent.trim() === `Documents (${docCount})`), entry.section + ': real document count');
      check(buttons.every(button => button.dataset.edit === String(entry.id) || button.dataset.delete === String(entry.id)), entry.section + ': correct record IDs');
      check(buttons.every(button => { const box = button.getBoundingClientRect(); return box.width >= 44 && box.height >= 44; }), entry.section + ': 44px action targets');
      const danger = getComputedStyle(card.querySelector('[data-delete]'));
      const alpha = /rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\)/.exec(danger.backgroundColor);
      check(danger.backgroundColor === 'rgba(0, 0, 0, 0)' || danger.backgroundColor === getComputedStyle(card).backgroundColor || (alpha && Number(alpha[1]) <= 0.15), entry.section + ': restrained outline delete');
      const grid = getComputedStyle(card.querySelector('.record-details'));
      const columns = grid.gridTemplateColumns.split(' ').filter(Boolean).length;
      check(columns === (viewportWidth <= 600 ? 1 : 2), entry.section + ': responsive detail columns');
      check(document.documentElement.scrollWidth <= innerWidth + 1, entry.section + ': no document overflow');
      check([...card.querySelectorAll('.field-item,.value,button,h3')].every(element => element.scrollWidth <= element.clientWidth + 1), entry.section + ': long content wraps without clipping');
      check(!document.querySelector('.record-card [data-nav^="add/"]') && !!document.querySelector(`.page-header [data-nav="add/${entry.section}"]`), entry.section + ': Add Entry remains at page level');
    }
    return checks;
  }, width);
}

async function checkActionWorkflows(page, origin) {
  const checks = [];
  const bank = await page.evaluate(() => window.recordCardFixtureSnapshot().all.find(entry => entry.section === 'bank_accounts'));
  const sectionHash = '#section/bank_accounts';
  const editHash = '#edit/bank_accounts/' + bank.id;
  const cardSelector = '.record-card:has([data-edit="' + bank.id + '"])';
  const editButton = () => page.locator(cardSelector + ' [data-edit]').filter({ hasText: /^\s*Edit\s*$/ });
  await openSection(page, origin, 'bank_accounts');
  await editButton().focus();
  assert.equal(await editButton().evaluate(button => getComputedStyle(button).outlineStyle !== 'none'), true, 'Keyboard focus has a visible outline');
  await page.keyboard.press('Enter');
  await page.waitForSelector('#entry-form');
  assert.equal(new URL(page.url()).hash, editHash, 'Edit opens the same record');
  checks.push('Edit is keyboard operable and opens the same record; focus is visible');

  await page.evaluate(hash => { location.hash = hash; }, sectionHash);
  await page.waitForSelector(cardSelector);
  await page.locator(cardSelector + ' [data-edit]').filter({ hasText: /Documents/ }).click();
  await page.waitForSelector('#entry-form .doc-section');
  assert.equal(new URL(page.url()).hash, editHash, 'Documents opens the same existing form');
  await page.waitForFunction(id => window.recordCardFixtureSnapshot().calls.some(call => call.route === '/api/documents?entryId=' + id), bank.id);
  checks.push('Documents uses the existing record document panel and record ID');

  await page.evaluate(hash => { location.hash = hash; }, sectionHash);
  await page.waitForSelector(cardSelector);
  const sensitive = page.locator(cardSelector + ' .value.sensitive').first();
  assert.equal(await sensitive.getAttribute('role'), 'button');
  assert.equal(await sensitive.getAttribute('tabindex'), '0');
  assert.equal(await sensitive.getAttribute('aria-pressed'), 'false');
  await sensitive.focus();
  await page.keyboard.press('Enter');
  assert.equal(await sensitive.getAttribute('aria-pressed'), 'true');
  assert.equal(await sensitive.evaluate(element => element.classList.contains('revealed')), true);
  await page.keyboard.press('Space');
  assert.equal(await sensitive.getAttribute('aria-pressed'), 'false');
  await sensitive.click();
  assert.equal(await sensitive.getAttribute('aria-pressed'), 'true');
  checks.push('Sensitive values support Enter, Space and pointer reveal with announced state');

  const deleteCalls = () => page.evaluate(() => window.recordCardFixtureSnapshot().calls.filter(call => call.method === 'deleteEntry').length);
  const before = await deleteCalls();
  page.once('dialog', dialog => dialog.dismiss());
  await page.locator(cardSelector + ' [data-delete]').click();
  assert.equal(await deleteCalls(), before);
  assert.equal(await page.locator(cardSelector).count(), 1);
  checks.push('Canceling delete sends no delete request and preserves the card');

  await page.evaluate(() => { window.cardFixtureDeleteFails = true; });
  page.once('dialog', dialog => dialog.accept());
  await page.locator(cardSelector + ' [data-delete]').click();
  await page.waitForSelector('.toast-error');
  assert.equal(await page.locator('.toast-error').textContent(), 'Synthetic deletion refused');
  assert.equal(await page.locator(cardSelector).count(), 1);
  checks.push('Failed deletion preserves data and displays the existing error feedback');

  await page.evaluate(() => { window.cardFixtureDeletePending = true; });
  page.once('dialog', dialog => dialog.accept());
  await page.locator(cardSelector + ' [data-delete]').click();
  await page.waitForFunction(selector => document.querySelector(selector)?.getAttribute('aria-busy') === 'true', cardSelector);
  assert.equal(await page.locator(cardSelector + ' button:not(:disabled)').count(), 0);
  await page.evaluate(() => { window.cardFixtureDeletePending = false; window.releaseRecordCardDeletion(); });
  await page.waitForSelector('.empty-state');
  assert.equal(await deleteCalls(), before + 2);
  assert.equal(await page.locator(cardSelector).count(), 0);
  checks.push('Confirmed deletion announces busy state, disables repeated actions, targets the selected synthetic record and refreshes the list');

  await openSection(page, origin, 'retirement', 'empty');
  assert.equal(await page.locator('.record-card').count(), 0);
  assert.equal(await page.locator('.empty-state [data-nav="add/retirement"]').count(), 1);
  checks.push('Empty section retains the existing Add Entry flow');

  await page.evaluate(() => { window.setRecordCardFixtures('all'); location.hash = 'search/Synthetic'; });
  await page.waitForSelector('.main-content .record-card');
  assert.equal(await page.locator('.main-content .record-card').count(), await page.evaluate(() => Object.values(SECTIONS).filter(section => !section.retired).length));
  assert.equal(await page.locator('.main-content .record-card [data-delete]').count(), 0);
  const searchEdit = page.locator('.record-card-footer [data-nav^="edit/"]').first();
  assert.equal(await searchEdit.count(), 1);
  const target = await searchEdit.getAttribute('data-nav');
  await searchEdit.click();
  await page.waitForSelector('#entry-form');
  assert.equal(new URL(page.url()).hash, '#' + target);
  checks.push('Search uses the same presentation, preserves preview routing and exposes only its Edit action');

  await page.goto(origin + '/#access');
  await page.waitForSelector('#access-form');
  await page.evaluate(() => window.renderRecordCardRecipient());
  await page.waitForSelector('.vault-readonly .record-card');
  const recipient = await page.evaluate(() => {
    const entries = window.recordCardFixtureSnapshot().all;
    return {
      count: document.querySelectorAll('.vault-readonly .record-card[id^="beneficiary-vault-entry-"]').length,
      protected: !document.querySelector('.vault-readonly [data-edit],.vault-readonly [data-delete],.vault-readonly [data-nav^="edit/"]'),
      preserved: entries.every(entry => {
        const card = document.getElementById('beneficiary-vault-entry-' + entry.id);
        return card?.classList.contains('record-card') && card.textContent.includes(entry.title) && Object.values(entry.fields).every(value => card.textContent.includes(value)) && card.textContent.includes(entry.notes);
      }),
      fits: document.documentElement.scrollWidth <= innerWidth + 1,
      expected: entries.length,
    };
  });
  assert.equal(recipient.count, recipient.expected);
  assert.equal(recipient.protected, true);
  assert.equal(recipient.preserved, true);
  assert.equal(recipient.fits, true);
  checks.push('Beneficiary cards preserve IDs, all authorized data and notes without owner actions');
  return checks;
}

async function checkTextResize(page, origin) {
  await openSection(page, origin, 'retirement');
  return page.evaluate(() => {
    const card = document.querySelector('.record-card');
    const text = card.textContent;
    // Explicit text-only resizing exercises fixed-size text too; shrinking the
    // CSS viewport separately covers the reflow equivalent of desktop zoom.
    const textNodes = card.querySelectorAll('h3,.field-item label,.field-item dt,.value,button,.record-category-chip');
    const sizes = [...textNodes].map(element => [element, parseFloat(getComputedStyle(element).fontSize)]);
    sizes.forEach(([element, size]) => { element.style.fontSize = size * 2 + 'px'; });
    return {
      unchanged: card.textContent === text,
      fits: document.documentElement.scrollWidth <= innerWidth + 1,
      no_clipping: [...card.querySelectorAll('.field-item,.value,button,h3')].every(element => element.scrollWidth <= element.clientWidth + 1),
      resized_text_nodes: sizes.length,
    };
  });
}

// The host WebKitGTK runner serializes this self-contained workflow. It checks
// external SVG support and responsive fields in a second browser engine.
async function runWebkitRecordCardWorkflow() {
  const checks = [];
  const check = (condition, label) => { if (!condition) throw new Error(label); checks.push(label); };
  const pause = () => new Promise(resolve => setTimeout(resolve, 20));
  const until = async (predicate, label) => {
    for (let n = 0; n < 250; n++) { if (predicate()) return; await pause(); }
    throw new Error('Timed out: ' + label);
  };
  const response = await fetch('/icons/record-icons.svg');
  check(response.ok && response.headers.get('Content-Type').includes('image/svg+xml'), 'SVG sprite has a supported image MIME type');
  for (const entry of window.recordCardFixtureSnapshot().all) {
    location.hash = 'section/' + entry.section;
    await until(() => document.querySelector(`.record-card [data-edit="${entry.id}"]`), entry.section);
    const card = document.querySelector(`.record-card [data-edit="${entry.id}"]`).closest('.record-card');
    await until(() => [...card.querySelectorAll('svg.record-icon use')].every(use => use.getBBox().width > 0), entry.section + ' SVG');
    check([...card.querySelectorAll('svg.record-icon use')].every(use => use.getBBox().width > 0), entry.section + ': title and action SVG icons render');
    check(Object.values(entry.fields).every(value => card.textContent.includes(value)) && card.textContent.includes(entry.notes), entry.section + ': fields and notes preserved');
    check(document.documentElement.scrollWidth <= innerWidth + 1, entry.section + ': fits 390px viewport');
    check([...card.querySelectorAll('.record-card-footer button')].every(button => button.getBoundingClientRect().height >= 44), entry.section + ': touch targets preserved');
  }
  return checks;
}

async function main() {
  fs.mkdirSync(output, { recursive: true });
  const playwright = require(process.env.PLAYWRIGHT_PACKAGE_PATH || 'playwright');
  const fixture = await createMobileFixtureServer({ publicRoot, checks: fixtureSetup });
  const report = { phase, synthetic_data_only: true, physical_devices_tested: false, public_root: publicRoot, engines: [], workflows: [], screenshots: [], limitations: ['The 200% zoom reflow check uses half the CSS viewport width and a 2x device scale, plus a separate explicit 200% text resize check. It does not automate the browser chrome zoom setting.'] };
  let browser;
  try {
    browser = await playwright[engine].launch({ headless: true });
    report.engines.push({ name: engine, version: browser.version() });
    for (const theme of themes) {
      for (const width of widths) {
        const context = await browser.newContext({ viewport: { width, height: width < 600 ? 900 : 1100 }, deviceScaleFactor: 1, isMobile: false, hasTouch: width <= 1024, reducedMotion: 'reduce', locale: 'en-ZA', timezoneId: 'Africa/Johannesburg' });
        await context.addInitScript(value => localStorage.setItem('lv_theme', value), theme);
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        try {
          await openSection(page, fixture.origin, 'retirement', 'reference');
          if (phase !== 'baseline') {
            const response = await context.request.get(fixture.origin + '/icons/record-icons.svg');
            assert.equal(response.ok(), true, 'SVG sprite is served successfully');
            assert.match(response.headers()['content-type'], /^image\/svg\+xml/, 'SVG sprite uses an image MIME type');
            await page.waitForFunction(() => [...document.querySelectorAll('svg.record-icon use')].every(use => use.getBBox().width > 0));
          }
          await screenshot(page, report, 'retirement-reference', width, theme);
          if (phase !== 'baseline') {
            await openSection(page, fixture.origin, 'retirement');
            const checks = await checkAllSectionCards(page, width);
            await screenshot(page, report, 'populated-schema', width, theme);
            if ([320, 820, 1440].includes(width)) checks.push(...await checkActionWorkflows(page, fixture.origin));
            if ([320, 1440].includes(width)) {
              const resize = await checkTextResize(page, fixture.origin);
              assert.equal(resize.unchanged && resize.fits && resize.no_clipping, true, theme + ' ' + width + 'px fits 200% text resizing');
              report.workflows.push({ engine, theme, width, scenario: '200%-text', ...resize });
              await screenshot(page, report, 'text-200-percent', width, theme);
            }
            report.workflows.push({ engine, theme, width, checks });
            process.stdout.write(`${engine} ${theme} ${width}px: ${checks.length} record card checks passed\n`);
          }
          assert.deepEqual(errors, [], `${engine} ${theme} ${width}px has no uncaught browser errors`);
        } finally { await context.close(); }
      }
    }
    if (phase !== 'baseline') {
      const context = await browser.newContext({ viewport: { width: 720, height: 550 }, deviceScaleFactor: 2, reducedMotion: 'reduce' });
      try {
        const page = await context.newPage();
        await openSection(page, fixture.origin, 'retirement');
        const checks = await checkAllSectionCards(page, 720);
        report.workflows.push({ engine, theme: 'dark', width: 720, scenario: '1440px at 200% reflow equivalent', checks });
        await screenshot(page, report, 'zoom-200-percent-reflow', 720, 'dark');
      } finally { await context.close(); }
    }
    if (phase !== 'baseline' && process.env.RECORD_CARDS_TEST_SYSTEM_WEBKIT === '1') {
      const manifest = path.join(output, 'system-webkit-manifest.json');
      fs.writeFileSync(manifest, JSON.stringify({ origin: fixture.origin, output, phase, widths: [390], theme: 'dark', screens: [['retirement-reference', '#section/retirement', '.record-card-footer']], workflow: runWebkitRecordCardWorkflow.toString() }));
      await new Promise((resolve, reject) => {
        const runner = spawn(process.env.PYTHON_BIN || 'python3', [path.join(__dirname, 'test-mobile-webkit.py'), manifest], { stdio: 'inherit' });
        runner.once('error', reject);
        runner.once('exit', code => code === 0 ? resolve() : reject(new Error('System WebKit runner exited ' + code)));
      });
      const webkitReport = JSON.parse(fs.readFileSync(path.join(output, 'system-webkit-report.json'), 'utf8'));
      report.engines.push(...webkitReport.engines);
      report.workflows.push(...webkitReport.screens);
    }
    fs.writeFileSync(path.join(output, `${phase}-report.json`), JSON.stringify(report, null, 2) + '\n');
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    process.stdout.write(`Saved ${report.screenshots.length} synthetic record card screenshots to ${output}\n`);
  } finally {
    if (browser) await browser.close();
    await fixture.close();
  }
}

main().catch(error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; });
