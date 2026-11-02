'use strict';

// Execute the real HomeBank module, sidebar and vault-count helper with a small
// DOM and synthetic API responses. No application database or bank file is read.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const frontend = path.resolve(__dirname, '../public/js');

function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function harness() {
  const ids = new Map();
  const calls = [];
  const errors = [];
  const escape = value => String(value ?? '').replace(/[&<>"']/g,
    character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  function element() {
    return {
      value: '', innerHTML: '', style: {}, setAttribute() {},
      querySelectorAll: () => [], appendChild() {},
      set textContent(value) { this.innerHTML = escape(value); }
    };
  }
  const app = element();
  Object.defineProperty(app, 'innerHTML', {
    get() { return this.html || ''; },
    set(value) {
      this.html = String(value);
      ids.clear(); ids.set('app', app);
      for (const [, id] of this.html.matchAll(/\bid="([^"]+)"/g)) ids.set(id, element());
    }
  });
  ids.set('app', app);
  const fixture = {
    calls, errors, app,
    window: { location: { hash: '#homebank' }, addEventListener() {} },
    document: {
      documentElement: element(), createElement: element, addEventListener() {},
      querySelector: selector => ids.get(selector.slice(1)) || null,
      querySelectorAll: () => []
    },
    localStorage: { getItem: () => null, setItem() {} },
    setTimeout() {}, setInterval() {}, console,
    summary: [{ section: 'bank_accounts', count: 2 }], wishCount: 3,
    overview: { config: { directory: '/synthetic/homebank', selectedFile: '' }, snapshot: null }
  };
  fixture.API = {
    async request(method, route) {
      calls.push({ method, route });
      if (route === '/homebank/overview') return fixture.overview;
      if (route.startsWith('/homebank/files')) return { files: [] };
      return { ok: true };
    },
    async getSummary() { calls.push({ method: 'GET', route: '/vault/summary' }); return fixture.summary; }
  };
  fixture.Legacy = { async countEntries() { return fixture.wishCount; } };
  const context = vm.createContext(fixture);
  for (const name of ['sections.js', 'app.js', 'homebank.js']) {
    let source = fs.readFileSync(path.join(frontend, name), 'utf8');
    if (name === 'app.js') source = source.replace(/handleRoute\(\);\s*$/, '');
    vm.runInContext(source, context, { filename: name });
  }
  vm.runInContext(`
    state.user = { name: 'Synthetic owner' };
    state.counts = { bank_accounts: 1 };
    showError = message => errors.push(message);
    globalThis.ui = {
      render: HomeBank.render,
      counts: () => state.counts
    };`, context);
  const browserUI = fixture.ui;
  fixture.ui = { render: browserUI.render, counts: () => JSON.parse(JSON.stringify(browserUI.counts())) };
  fixture.control = id => ids.get(id);
  fixture.leave = () => { fixture.window.location.hash = '#settings'; app.innerHTML = '<p>Other route</p>'; };
  return fixture;
}

function sidebarCount(html, section, count) {
  assert.match(html, new RegExp(`data-nav="section/${section}"[^>]*>[\\s\\S]*?<span class="count">${count}</span>\\s*</button>`));
}

test('HomeBank renders sidebar counts from the vault after the overview sync, including protected wishes', async () => {
  const fixture = harness();
  await fixture.ui.render();
  assert.deepEqual(fixture.calls.slice(0, 2), [
    { method: 'GET', route: '/homebank/overview' },
    { method: 'GET', route: '/vault/summary' }
  ]);
  assert.deepEqual(fixture.ui.counts(), { bank_accounts: 2, final_wishes: 3 });
  sidebarCount(fixture.app.innerHTML, 'bank_accounts', 2);
  sidebarCount(fixture.app.innerHTML, 'final_wishes', 3);
});

for (const action of ['sync', 'settings']) {
  test(`HomeBank ${action} updates navigation counts immediately after saving`, async () => {
    const fixture = harness();
    await fixture.ui.render();
    const request = fixture.API.request;
    fixture.API.request = async (method, route) => {
      if (route === `/homebank/${action}`) fixture.summary = [{ section: 'bank_accounts', count: 5 }];
      return request(method, route);
    };
    if (action === 'sync') await fixture.control('hb-sync').onclick();
    else await fixture.control('hb-settings-form').onsubmit({ preventDefault() {} });
    sidebarCount(fixture.app.innerHTML, 'bank_accounts', 5);
    assert.equal(fixture.ui.counts().bank_accounts, 5);
  });
}

test('a failed vault summary preserves the last known sidebar counts and displays the overview', async () => {
  const fixture = harness();
  fixture.API.getSummary = async () => { throw new Error('Synthetic unavailable summary'); };
  await fixture.ui.render();
  assert.match(fixture.app.innerHTML, /HomeBank Financial Overview/);
  sidebarCount(fixture.app.innerHTML, 'bank_accounts', 1);
  assert.deepEqual(fixture.ui.counts(), { bank_accounts: 1 });
  assert.deepEqual(fixture.errors, []);
});

test('a late HomeBank overview cannot replace a different route or refresh its counts', async () => {
  const fixture = harness();
  const pending = deferred();
  fixture.API.request = () => pending.promise;
  const render = fixture.ui.render();
  fixture.leave();
  pending.resolve(fixture.overview);
  await render;
  assert.equal(fixture.app.innerHTML, '<p>Other route</p>');
  assert.deepEqual(fixture.ui.counts(), { bank_accounts: 1 });
  assert.equal(fixture.calls.length, 0);
});

test('a late summary cannot replace another route or change its counts', async () => {
  const fixture = harness();
  const pending = deferred();
  const requested = deferred();
  fixture.API.getSummary = () => { requested.resolve(); return pending.promise; };
  const render = fixture.ui.render();
  await requested.promise;
  fixture.leave();
  pending.resolve([{ section: 'bank_accounts', count: 99 }]);
  await render;
  assert.equal(fixture.app.innerHTML, '<p>Other route</p>');
  assert.deepEqual(fixture.ui.counts(), { bank_accounts: 1 });
});

test('overlapping HomeBank renders keep the newest sidebar counts', async () => {
  const fixture = harness();
  const pending = deferred();
  const requested = deferred();
  fixture.API.getSummary = () => { requested.resolve(); return pending.promise; };
  const olderRender = fixture.ui.render();
  await requested.promise;
  fixture.API.getSummary = async () => [{ section: 'bank_accounts', count: 8 }];
  await fixture.ui.render();
  pending.resolve([{ section: 'bank_accounts', count: 99 }]);
  await olderRender;
  sidebarCount(fixture.app.innerHTML, 'bank_accounts', 8);
  assert.equal(fixture.ui.counts().bank_accounts, 8);
});

test('a late file-list failure leaves a newly navigated page intact', async () => {
  const fixture = harness();
  const pending = deferred();
  const requested = deferred();
  const request = fixture.API.request;
  fixture.API.request = (method, route) => {
    if (route.startsWith('/homebank/files')) { requested.resolve(); return pending.promise; }
    return request(method, route);
  };
  const render = fixture.ui.render();
  await requested.promise;
  fixture.leave();
  pending.reject(new Error('Synthetic stale file-list failure'));
  await render;
  assert.equal(fixture.app.innerHTML, '<p>Other route</p>');
  assert.deepEqual(fixture.errors, []);
});

for (const action of ['sync', 'settings']) {
  test(`a late ${action} response does not reopen HomeBank after navigation`, async () => {
    const fixture = harness();
    await fixture.ui.render();
    const pending = deferred();
    const request = fixture.API.request;
    fixture.API.request = (method, route) => route === `/homebank/${action}` ? pending.promise : request(method, route);
    const save = action === 'sync'
      ? fixture.control('hb-sync').onclick()
      : fixture.control('hb-settings-form').onsubmit({ preventDefault() {} });
    fixture.leave();
    pending.resolve({ ok: true });
    await save;
    assert.equal(fixture.app.innerHTML, '<p>Other route</p>');
    assert.equal(fixture.calls.filter(call => call.route === '/homebank/overview').length, 1);
    assert.deepEqual(fixture.errors, []);
  });
}
