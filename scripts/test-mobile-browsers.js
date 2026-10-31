#!/usr/bin/env node
'use strict';

// Optional visual/browser matrix. Playwright stays outside production dependencies.
// PLAYWRIGHT_PACKAGE_PATH=/absolute/path/to/playwright node scripts/test-mobile-browsers.js
// BROWSER_TEST_PUBLIC_ROOT=/tmp/baseline/public BROWSER_TEST_PHASE=baseline captures a reference.
// BROWSER_TEST_REFERENCE_DIR=/tmp/baseline-results additionally compares desktop PNGs exactly.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createMobileFixtureServer, runMobileWorkflow } = require('../tests/helpers/mobile-browser-fixture');

const widths = (process.env.BROWSER_TEST_WIDTHS || '320,360,390,412,768,820,1024,1280,1440').split(',').map(Number);
const output = path.resolve(process.env.BROWSER_TEST_OUTPUT_DIR || '/tmp/wolfs-legacy-mobile-browser-results');
const phase = process.env.BROWSER_TEST_PHASE || 'after';
const engines = (process.env.BROWSER_TEST_ENGINES || 'chromium').split(',');
const reference = process.env.BROWSER_TEST_REFERENCE_DIR;
const publicRoot = process.env.BROWSER_TEST_PUBLIC_ROOT ? path.resolve(process.env.BROWSER_TEST_PUBLIC_ROOT) : path.resolve(__dirname, '../public');
const theme = process.env.BROWSER_TEST_THEME || 'dark';
const heightOverride = process.env.BROWSER_TEST_HEIGHT ? Number(process.env.BROWSER_TEST_HEIGHT) : null;
const screens = [
  ['login', '#login', '#login-form'],
  ['dashboard', '#vault', '.vault-grid'],
  ['bank-accounts', '#section/bank_accounts', '[data-edit="13"]'],
  ['final-wishes', '#section/final_wishes', '.legacy-tabs'],
  ['letter-editor', '#add/final_wishes?type=letter', '#legacy-editor'],
  ['beneficiaries', '#beneficiaries', '#add-ben-btn'],
  ['homebank', '#homebank', '.hb-account'],
  ['settings', '#settings', '#notification-title'],
  ['recipient', '#access', '[data-recipient-content]'],
  ['recording', '#access', '.doc-preview-body audio'],
];

async function openScreen(page, origin, name, hash, ready) {
  await page.goto(origin + '/?screen=' + name + hash);
  if (name === 'recipient' || name === 'recording') {
    await page.waitForSelector('#access-form');
    await page.evaluate(() => window.renderMobileRecipient());
    if (name === 'recording') {
      await page.locator('[data-recipient-content]').click();
      await page.locator('[data-legacy-file][data-mode="preview"]').click();
    }
  }
  await page.waitForSelector(ready);
  await page.evaluate(() => document.fonts.ready);
  // Let initial async sections and the drawer's transition finish before measuring.
  await page.waitForTimeout(180);
}

async function main() {
  fs.mkdirSync(output, { recursive: true });
  const playwright = engines.some(engine => engine !== 'system-webkit') ? require(process.env.PLAYWRIGHT_PACKAGE_PATH || 'playwright') : null;
  const fixture = await createMobileFixtureServer({ publicRoot });
  const report = { phase, theme, synthetic_data_only: true, public_root: publicRoot, engines: [], screens: [] };
  try {
    for (const engine of engines) {
      if (engine === 'system-webkit') {
        const manifest = path.join(output, 'system-webkit-manifest.json');
        fs.writeFileSync(manifest, JSON.stringify({ origin: fixture.origin, output, phase, widths, screens, reference, theme, height: heightOverride, workflow: runMobileWorkflow.toString() }));
        await new Promise((resolve, reject) => {
          const runner = spawn(process.env.PYTHON_BIN || 'python3', [path.join(__dirname, 'test-mobile-webkit.py'), manifest], { stdio: 'inherit' });
          runner.once('error', reject);
          runner.once('exit', code => code === 0 ? resolve() : reject(new Error(`System WebKit runner exited ${code}`)));
        });
        const webkitReport = JSON.parse(fs.readFileSync(path.join(output, 'system-webkit-report.json'), 'utf8'));
        report.engines.push(...webkitReport.engines);
        report.screens.push(...webkitReport.screens);
        continue;
      }
      const browser = await playwright[engine].launch({ headless: true });
      report.engines.push({ name: engine, version: browser.version() });
      try {
        for (const width of widths) {
          const mobile = width <= 1024;
          const context = await browser.newContext({ viewport: { width, height: heightOverride || (width >= 768 ? 1100 : 844) }, deviceScaleFactor: 1, isMobile: mobile, hasTouch: mobile, reducedMotion: 'reduce', locale: 'en-ZA', timezoneId: 'Africa/Johannesburg' });
          await context.addInitScript(value => localStorage.setItem('lv_theme', value), theme);
          const page = await context.newPage();
          const pageErrors = [];
          page.on('pageerror', error => pageErrors.push(error.message));
          for (const [name, hash, ready] of screens) {
            await openScreen(page, fixture.origin, name, hash, ready);
            const metrics = await page.evaluate(() => {
              const visible = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden' && !el.closest('[inert]'); };
              return {
                width: innerWidth,
                height: innerHeight,
                document_width: document.documentElement.scrollWidth,
                overflow: document.documentElement.scrollWidth > innerWidth + 1,
                undersized_text_inputs: Array.from(document.querySelectorAll('input:not([type="checkbox"]):not([type="radio"]):not([type="hidden"]),select,textarea')).filter(visible).filter(el => parseFloat(getComputedStyle(el).fontSize) < 16).map(el => el.id || el.name),
                drawer_hidden: document.querySelector('#mobile-navigation')?.getAttribute('aria-hidden'),
              };
            });
            const filename = `${engine}-${name}-${width}.png`;
            const screenshot = await page.screenshot({ path: path.join(output, filename), fullPage: true, animations: 'disabled' });
            const row = { engine, screen: name, width, ...metrics, screenshot: filename };
            if (phase !== 'baseline' && mobile) {
              assert.equal(metrics.overflow, false, `${engine} ${name} at ${width}px has document overflow (${metrics.document_width}px)`);
              assert.deepEqual(metrics.undersized_text_inputs, [], `${engine} ${name} at ${width}px has inputs that cause iOS focus zoom`);
            }
            if (reference && width > 1024) {
              const baseline = fs.readFileSync(path.join(reference, filename));
              row.desktop_identical = crypto.createHash('sha256').update(screenshot).digest('hex') === crypto.createHash('sha256').update(baseline).digest('hex');
              assert.equal(row.desktop_identical, true, `${engine} ${name} at ${width}px changed desktop rendering`);
            }
            report.screens.push(row);
            process.stdout.write(`${phase} ${engine} ${name} ${width}px: ${metrics.overflow ? 'overflow ' + metrics.document_width : 'fits'}\n`);
          }
          if (phase !== 'baseline' && [390, 820].includes(width)) {
            await page.goto(fixture.origin + '/?screen=workflow#vault');
            const checks = await page.evaluate(runMobileWorkflow);
            await page.goto(fixture.origin + '/?screen=resize#vault');
            await page.locator('#mobile-menu-toggle').click();
            await page.setViewportSize({ width: 1440, height: 1000 });
            await page.waitForTimeout(180);
            assert.equal(await page.locator('.sidebar').evaluate(el => el.inert), false, `${engine} sidebar remains interactive after widening to desktop`);
            assert.equal(await page.locator('#mobile-menu-toggle').isVisible(), false, `${engine} desktop hides the mobile trigger`);
            await page.setViewportSize({ width, height: heightOverride || 1000 });
            await page.waitForTimeout(180);
            assert.equal(await page.locator('#mobile-menu-toggle').getAttribute('aria-expanded'), 'false', `${engine} resizing back closes the drawer`);
            assert.equal(await page.locator('.sidebar').evaluate(el => el.inert), true, `${engine} resizing back deactivates the hidden sidebar`);
            report.screens.push({ engine, screen: 'workflows', width, checks: [...checks, 'resizing an open drawer to desktop and back resets visibility and focusability'] });
            process.stdout.write(`${phase} ${engine} workflows ${width}px: ${checks.length + 1} checks passed\n`);
          }
          assert.deepEqual(pageErrors, [], `${engine} at ${width}px had uncaught browser errors`);
          await context.close();
        }
      } finally { await browser.close(); }
    }
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    process.stdout.write(`Saved ${report.screens.filter(row => row.screenshot).length} synthetic browser captures and ${report.screens.filter(row => row.checks).length} workflow reports to ${output}\n`);
  } finally { await fixture.close(); }
}

main().catch(error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; });
