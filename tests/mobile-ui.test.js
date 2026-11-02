'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createMobileFixtureServer, runMobileWorkflow } = require('./helpers/mobile-browser-fixture');

const firefox = [process.env.FIREFOX_BIN, '/usr/bin/firefox', '/usr/bin/firefox-esr'].filter(Boolean)
  .find(candidate => { try { fs.accessSync(candidate, fs.constants.X_OK); return true; } catch { return false; } });

for (const width of [390, 820]) {
  test(`mobile owner and beneficiary workflows render and remain protected in Firefox at ${width}px`, {
    timeout: 60000,
    skip: firefox ? false : 'Firefox not installed; set FIREFOX_BIN for mobile browser acceptance',
  }, async t => {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wolfs-mobile-ui-firefox-'));
    let browser;
    let timer;
    let browserErrors = '';
    let resolveResult;
    let rejectResult;
    const result = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
    const checks = `(${runMobileWorkflow.toString()})().then(checks=>fetch('/mobile-test-result',{method:'POST',body:JSON.stringify({ok:true,width:innerWidth,checks})})).catch(error=>fetch('/mobile-test-result',{method:'POST',body:JSON.stringify({ok:false,error:error.message,stack:error.stack})}));`;
    const fixture = await createMobileFixtureServer({ checks, onResult: resolveResult });
    t.after(async () => {
      clearTimeout(timer);
      if (browser && browser.exitCode === null) {
        browser.kill('SIGTERM');
        await Promise.race([new Promise(resolve => browser.once('close', resolve)), new Promise(resolve => setTimeout(() => { browser.kill('SIGKILL'); resolve(); }, 2000).unref())]);
      }
      await fixture.close();
      fs.rmSync(profile, { recursive: true, force: true });
    });
    browser = spawn(firefox, ['--headless', '--no-remote', '--profile', profile, '--width', String(Math.max(width, 820)), '--height', '1000', fixture.origin + '/?mobile-frame=' + width], { stdio: ['ignore', 'ignore', 'pipe'] });
    browser.stderr.on('data', chunk => { browserErrors = (browserErrors + String(chunk)).slice(-3000); });
    browser.once('error', rejectResult);
    browser.once('exit', code => { if (code !== null && code !== 0) rejectResult(new Error(`Firefox exited ${code}: ${browserErrors}`)); });
    timer = setTimeout(() => rejectResult(new Error(`Mobile Firefox checks timed out: ${browserErrors}`)), 45000);
    const report = await result;
    assert.equal(report.ok, true, [report.error, report.stack].filter(Boolean).join('\n'));
    assert.equal(report.width, width);
    assert.ok(report.checks.length >= 25);
    t.diagnostic(report.checks.join('; '));
  });
}
