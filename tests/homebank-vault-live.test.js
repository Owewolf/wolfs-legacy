'use strict';

// Run the real frontend functions against synthetic data. Timers are captured,
// never started, and the small DOM below implements only the browser surfaces
// used by record/section rendering. No credentials, bank files, or vault data
// are read by this harness.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const frontend = path.resolve(__dirname, '../public/js');
const appSource = fs.readFileSync(path.join(frontend, 'app.js'), 'utf8');
const sectionSource = fs.readFileSync(path.join(frontend, 'sections.js'), 'utf8');

function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function vehicle(id = 42, overrides = {}) {
  return {
    id, homebank_account_id: 100 + id, section: 'vehicles', title: `Fixture vehicle ${id}`,
    fields: { registration: `FIXTURE-${id}`, make_model: 'Fixture model',
      loan_balance: 'ZAR 342328.04', loan_provider: 'Fixture lender Alpha' },
    notes: '', homebank_managed_fields: ['loan_balance', 'loan_provider'],
    ...overrides
  };
}

function makeHarness({ hash = '#edit/vehicles/42', entry = vehicle() } = {}) {
  const intervals = [];
  const documentListeners = new Map();
  const windowListeners = new Map();
  const warnings = [];
  const scrolls = [];
  const ids = new Map();
  const controls = new Map();
  let selection = '';
  let htmlWrites = 0;
  let mountCalls = 0;
  let docCountCalls = 0;

  const escape = value => String(value ?? '').replace(/[&<>"']/g,
    character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  const unescape = value => String(value ?? '').replace(/&(amp|lt|gt|quot|#39);/g,
    entity => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" }[entity]));

  function element(tagName = 'div') {
    let html = '';
    let content = '';
    const attributes = new Map();
    return {
      tagName: tagName.toUpperCase(), value: '', readOnly: false, disabled: false,
      style: {}, classList: { add() {}, toggle() {} },
      setAttribute(name, value) { attributes.set(name, String(value)); },
      getAttribute(name) { return attributes.get(name) ?? null; },
      matches(selector) { return selector.split(',').includes(tagName); },
      querySelector(selector) { return document.querySelector(selector); },
      querySelectorAll() { return []; },
      appendChild() {}, remove() {},
      get innerHTML() { return html; },
      set innerHTML(value) { html = String(value); },
      get textContent() { return content; },
      set textContent(value) { content = String(value ?? ''); html = escape(content); }
    };
  }

  const app = element();
  Object.defineProperty(app, 'innerHTML', {
    get() { return app.html || ''; },
    set(html) {
      app.html = String(html);
      htmlWrites++;
      ids.clear(); controls.clear(); ids.set('app', app);
      for (const match of app.html.matchAll(/\bid="([^"]+)"/g)) ids.set(match[1], element());
      for (const match of app.html.matchAll(/<(input|textarea|select)\b([^>]*)>(?:([\s\S]*?)<\/\1>)?/g)) {
        const [, tag, attributeText, contents = ''] = match;
        const attrs = Object.fromEntries([...attributeText.matchAll(/([\w:-]+)(?:="([^"]*)")?/g)]
          .map(([, key, value]) => [key, unescape(value ?? '')]));
        const control = element(tag);
        control.name = attrs.name;
        control.value = tag === 'textarea' ? unescape(contents) : (attrs.value || '');
        control.readOnly = Object.hasOwn(attrs, 'readonly');
        for (const [key, value] of Object.entries(attrs)) control.setAttribute(key, value);
        if (attrs.name) controls.set(attrs.name, control);
        if (attrs.id) ids.set(attrs.id, control);
      }
    }
  });
  ids.set('app', app);
  const document = {
    hidden: false, activeElement: null, documentElement: element('html'), body: element('body'),
    createElement: element,
    querySelector(selector) {
      const field = /^#entry-form \[name="([^"]+)"\]$/.exec(selector);
      if (field) return controls.get(field[1]) || null;
      return selector.startsWith('#') ? ids.get(selector.slice(1)) || null : null;
    },
    querySelectorAll() { return []; },
    addEventListener(name, handler) { documentListeners.set(name, handler); }
  };
  let currentHash = hash;
  const location = {};
  Object.defineProperty(location, 'hash', {
    get() { return currentHash; },
    set(value) { currentHash = value ? (String(value).startsWith('#') ? String(value) : '#' + value) : ''; }
  });
  const window = {
    location, scrollY: 123,
    addEventListener(name, handler) { windowListeners.set(name, handler); },
    getSelection() { return { toString: () => selection }; },
    scrollTo(x, y) { scrolls.push([x, y]); }
  };
  const storage = new Map();
  const API = {
    token: 'fixture-only-token', getEntry: async () => entry,
    getEntries: async () => ({ entries: [entry] }),
    getSummary: async () => [{ section: 'vehicles', count: 1 }]
  };
  const documentWidget = { queued: ['Fixture unsaved document'], uploadQueued: async () => ({ failed: [] }) };
  const sandbox = {
    document, window, API,
    Docs: {
      panel: () => '<div id="fixture-documents"></div>',
      mount: () => { mountCalls++; return documentWidget; },
      counts: async () => { docCountCalls++; return {}; }
    },
    localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) },
    console: { warn: (...args) => warnings.push(args) },
    setInterval(handler, milliseconds) { intervals.push({ handler, milliseconds }); },
    setTimeout() {}, clearTimeout() {}
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(sectionSource, context, { filename: 'sections.js' });
  assert.match(appSource, /handleRoute\(\);\s*$/);
  // Skip only initial navigation; execute all actual definitions and event/timer
  // registration, then expose the same functions a browser invokes.
  vm.runInContext(appSource.replace(/handleRoute\(\);\s*$/, `
    globalThis.fixtureApp = {
      renderEntryForm, renderSection, refreshLiveVault,
      setUser(user) { state.user = user; },
      entries() { return state.entries; },
      editingEntry() { return editingHomebankEntry; }
    };`), context, { filename: 'app.js' });
  sandbox.fixtureApp.setUser({ id: 901, name: 'Fixture owner' });
  assert.equal(intervals.length, 1);
  assert.equal(intervals[0].milliseconds, 20000);
  return {
    ...sandbox, app, controls, documentWidget, documentListeners, windowListeners, warnings, scrolls,
    tick: intervals[0].handler,
    setSelection(value) { selection = value; },
    get htmlWrites() { return htmlWrites; },
    get mountCalls() { return mountCalls; },
    get docCountCalls() { return docCountCalls; }
  };
}

test('live edit refresh changes managed balances/providers while preserving unsaved owner fields and documents', async () => {
  const fixture = makeHarness();
  await fixture.fixtureApp.renderEntryForm('vehicles', '42');
  assert.equal(fixture.controls.has('notes'), false);
  assert.doesNotMatch(fixture.app.innerHTML, /<label>Notes<\/label>/);
  const registration = fixture.controls.get('registration');
  const title = fixture.controls.get('title');
  registration.value = 'UNSAVED-OWNER-REGISTRATION';
  title.value = 'Unsaved owner title';
  const initialWrites = fixture.htmlWrites;
  fixture.document.activeElement = registration;
  fixture.API.getEntry = async () => vehicle(42, {
    fields: { registration: 'Stale source registration', make_model: 'Stale source model',
      loan_balance: 'EUR -40.45', loan_provider: 'Fixture lender Beta' }
  });
  await fixture.tick();
  assert.equal(fixture.controls.get('loan_balance').value, 'EUR -40.45');
  assert.equal(fixture.controls.get('loan_provider').value, 'Fixture lender Beta');
  assert.equal(fixture.controls.get('loan_balance').readOnly, true);
  assert.equal(fixture.controls.get('loan_balance').getAttribute('aria-readonly'), 'true');
  assert.equal(registration.value, 'UNSAVED-OWNER-REGISTRATION');
  assert.equal(title.value, 'Unsaved owner title');
  assert.equal(fixture.document.activeElement, registration);
  assert.equal(fixture.htmlWrites, initialWrites, 'Polling must not replace the edit form');
  assert.equal(fixture.mountCalls, 1, 'Polling must not remount queued document uploads');
  assert.deepEqual(fixture.documentWidget.queued, ['Fixture unsaved document']);

  fixture.API.getEntry = async () => vehicle(42, {
    fields: { loan_balance: 'ZAR 0.00' }, homebank_managed_fields: ['loan_balance']
  });
  await fixture.tick();
  assert.equal(fixture.controls.get('loan_provider').value, '');
  assert.equal(fixture.controls.get('loan_provider').readOnly, false);
  assert.equal(fixture.controls.get('loan_provider').getAttribute('aria-readonly'), 'false');
  assert.equal(registration.value, 'UNSAVED-OWNER-REGISTRATION');
});

test('an old edit refresh cannot change a newly navigated form', async () => {
  const fixture = makeHarness();
  await fixture.fixtureApp.renderEntryForm('vehicles', '42');
  const oldRequest = deferred();
  fixture.API.getEntry = id => String(id) === '42' ? oldRequest.promise : Promise.resolve(vehicle(43));
  const pending = fixture.tick();
  fixture.window.location.hash = '#edit/vehicles/43';
  await fixture.fixtureApp.renderEntryForm('vehicles', '43');
  fixture.controls.get('registration').value = 'UNSAVED-NEW-VEHICLE';
  const currentBalance = fixture.controls.get('loan_balance');
  const currentWrites = fixture.htmlWrites;
  oldRequest.resolve(vehicle(42, { fields: { loan_balance: 'ZAR 999999.99' } }));
  await pending;
  assert.equal(fixture.controls.get('loan_balance'), currentBalance);
  assert.equal(currentBalance.value, 'ZAR 342328.04');
  assert.equal(fixture.controls.get('registration').value, 'UNSAVED-NEW-VEHICLE');
  assert.equal(fixture.fixtureApp.editingEntry().id, 43);
  assert.equal(fixture.htmlWrites, currentWrites);
});

test('section polling renders changed data without a second entries fetch and leaves unchanged data alone', async () => {
  const fixture = makeHarness({ hash: '#section/vehicles' });
  let fetches = 0;
  let entry = vehicle();
  fixture.API.getEntries = async () => { fetches++; return { entries: [entry] }; };
  await fixture.fixtureApp.renderSection('vehicles');
  assert.match(fixture.app.innerHTML, /ZAR 342328\.04/);
  assert.equal(fetches, 1);
  entry = vehicle(42, { fields: { loan_balance: 'EUR -40.45', loan_provider: 'Fixture lender Beta' } });
  const previousWrites = fixture.htmlWrites;
  await fixture.tick();
  assert.equal(fetches, 2, 'Render must consume the snapshot fetched by the poll');
  assert.equal(fixture.htmlWrites, previousWrites + 1);
  assert.match(fixture.app.innerHTML, /EUR -40\.45/);
  assert.doesNotMatch(fixture.app.innerHTML, /ZAR 342328\.04|<label[^>]*>Notes<\/label>/);
  assert.deepEqual(fixture.scrolls, [[0, 123]]);
  const renderedWrites = fixture.htmlWrites;
  const documentReads = fixture.docCountCalls;
  await fixture.tick();
  assert.equal(fetches, 3);
  assert.equal(fixture.htmlWrites, renderedWrites);
  assert.equal(fixture.docCountCalls, documentReads);
});

test('section refresh defers while an input is focused or text is selected', async () => {
  const fixture = makeHarness({ hash: '#section/vehicles' });
  await fixture.fixtureApp.renderSection('vehicles');
  let fetches = 0;
  fixture.API.getEntries = async () => { fetches++; return { entries: [vehicle(43)] }; };
  const input = fixture.document.querySelector('#global-search');
  input.value = 'Unsaved search text';
  fixture.document.activeElement = input;
  const initialWrites = fixture.htmlWrites;
  await fixture.tick();
  assert.equal(fetches, 0);
  assert.equal(input.value, 'Unsaved search text');
  fixture.document.activeElement = null;
  fixture.setSelection('Text the owner is reading');
  await fixture.tick();
  assert.equal(fetches, 0);
  assert.equal(fixture.htmlWrites, initialWrites);
  fixture.setSelection('');
  await fixture.tick();
  assert.equal(fetches, 1);
  assert.match(fixture.app.innerHTML, /Fixture vehicle 43/);
});

test('a section response arriving after the owner starts typing does not replace that input', async () => {
  const fixture = makeHarness({ hash: '#section/vehicles' });
  await fixture.fixtureApp.renderSection('vehicles');
  const sourceRead = deferred();
  fixture.API.getEntries = () => sourceRead.promise;
  const pending = fixture.tick();
  const input = fixture.document.querySelector('#global-search');
  input.value = 'New typing after the poll started';
  fixture.document.activeElement = input;
  const initialWrites = fixture.htmlWrites;
  sourceRead.resolve({ entries: [vehicle(43)] });
  await pending;
  assert.equal(fixture.htmlWrites, initialWrites);
  assert.equal(fixture.document.querySelector('#global-search'), input);
  assert.equal(input.value, 'New typing after the poll started');
  fixture.document.activeElement = null;
  fixture.API.getEntries = async () => ({ entries: [vehicle(43)] });
  await fixture.tick();
  assert.match(fixture.app.innerHTML, /Fixture vehicle 43/, 'A deferred repaint must happen after focus is released');
});

test('typing during section metadata loading also defers the paint until focus is released', async () => {
  const fixture = makeHarness({ hash: '#section/vehicles' });
  await fixture.fixtureApp.renderSection('vehicles');
  const metadataRead = deferred();
  const metadataStarted = deferred();
  fixture.API.getEntries = async () => ({ entries: [vehicle(43)] });
  fixture.Docs.counts = () => { metadataStarted.resolve(); return metadataRead.promise; };
  const pending = fixture.tick();
  await metadataStarted.promise;
  const input = fixture.document.querySelector('#global-search');
  input.value = 'Owner typing while metadata is loading';
  fixture.document.activeElement = input;
  const initialWrites = fixture.htmlWrites;
  metadataRead.resolve({});
  await pending;
  assert.equal(fixture.htmlWrites, initialWrites);
  assert.equal(fixture.document.querySelector('#global-search'), input);
  assert.equal(input.value, 'Owner typing while metadata is loading');
  fixture.document.activeElement = null;
  fixture.Docs.counts = async () => ({});
  await fixture.tick();
  assert.match(fixture.app.innerHTML, /Fixture vehicle 43/, 'Skipped paints must not mark unseen data as displayed');
});

test('hidden tabs and overlapping polls do not fetch; visibility resumes refresh after the pending request', async () => {
  const fixture = makeHarness();
  await fixture.fixtureApp.renderEntryForm('vehicles', '42');
  let fetches = 0;
  const sourceRead = deferred();
  fixture.API.getEntry = () => { fetches++; return sourceRead.promise; };
  fixture.document.hidden = true;
  await fixture.tick();
  fixture.documentListeners.get('visibilitychange')();
  assert.equal(fetches, 0);
  fixture.document.hidden = false;
  const pending = fixture.tick();
  await fixture.tick();
  fixture.documentListeners.get('visibilitychange')();
  assert.equal(fetches, 1, 'Only one source request may be in flight');
  sourceRead.resolve(vehicle());
  await pending;
  fixture.API.getEntry = async () => { fetches++; return vehicle(); };
  fixture.documentListeners.get('visibilitychange')();
  await Promise.resolve();
  assert.equal(fetches, 2, 'Returning to the tab requests current source data');
});

test('a removed or filtered source account returns the active editor to its section', async () => {
  const fixture = makeHarness();
  await fixture.fixtureApp.renderEntryForm('vehicles', '42');
  fixture.API.getEntry = async () => { throw new Error('Not found'); };
  await fixture.tick();
  assert.equal(fixture.window.location.hash, '#section/vehicles');

  fixture.window.location.hash = '#edit/vehicles/42';
  const sourceRead = deferred();
  fixture.API.getEntry = () => sourceRead.promise;
  const pending = fixture.tick();
  fixture.window.location.hash = '#section/bank_accounts';
  sourceRead.reject(new Error('Not found'));
  await pending;
  assert.equal(fixture.window.location.hash, '#section/bank_accounts', 'A stale 404 must not undo later navigation');
});

test('source errors keep the current form and release the poll lock for retry', async () => {
  const fixture = makeHarness();
  await fixture.fixtureApp.renderEntryForm('vehicles', '42');
  const writes = fixture.htmlWrites;
  fixture.controls.get('registration').value = 'UNSAVED-THROUGH-ERROR';
  fixture.API.getEntry = async () => { throw new Error('Fixture source temporarily unavailable'); };
  await fixture.tick();
  assert.equal(fixture.window.location.hash, '#edit/vehicles/42');
  assert.equal(fixture.controls.get('registration').value, 'UNSAVED-THROUGH-ERROR');
  assert.equal(fixture.htmlWrites, writes);
  fixture.API.getEntry = async () => vehicle(42, { fields: { loan_balance: 'ZAR 1.00' } });
  await fixture.tick();
  assert.equal(fixture.controls.get('loan_balance').value, 'ZAR 1.00');
  assert.equal(fixture.controls.get('registration').value, 'UNSAVED-THROUGH-ERROR');
});
