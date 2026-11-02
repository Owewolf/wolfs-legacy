'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/js/api.js'), 'utf8');
function client(fetch, token = 'synthetic-api-token') {
  const storage = new Map(token ? [['lv_token', token]] : []);
  return vm.runInNewContext(source + '\nAPI;', {
    fetch,
    localStorage: {
      getItem: key => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: key => storage.delete(key),
    },
  }, { filename: 'api.js' });
}

test('API client requests JSON and preserves authenticated request and response behavior', async () => {
  let captured;
  const api = client(async (url, options) => {
    captured = { url, options };
    return new Response('{"success":true}', { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
  });
  assert.deepEqual(await api.request('POST', '/notifications/test', { password: 'synthetic-password' }), { success: true });
  assert.equal(captured.url, '/api/notifications/test');
  assert.equal(captured.options.headers.Accept, 'application/json');
  assert.equal(captured.options.headers.Authorization, 'Bearer synthetic-api-token');
  assert.equal(captured.options.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(captured.options.body), { password: 'synthetic-password' });
});

test('API client reports unavailable notification endpoints before attempting to parse an HTML app page', async () => {
  for (const route of ['/notifications', '/notifications?refresh=1', '/notifications/verify/start']) {
    let parsed = false;
    const api = client(async () => ({
      ok: true,
      headers: new Headers({ 'Content-Type': 'text/html; charset=utf-8' }),
      async json() { parsed = true; throw new Error('secret HTML or token contents'); },
    }));
    await assert.rejects(api.request('GET', route), { message: 'Email setup is not available on this server yet.' });
    assert.equal(parsed, false);
  }
});

test('unexpected API content types have a readable error without echoing response content or credentials', async () => {
  for (const contentType of ['text/html', 'text/plain', 'application/javascript', '']) {
    const api = client(async () => new Response('<html>private-server-body synthetic-api-token</html>', {
      status: 502, headers: { 'Content-Type': contentType },
    }));
    await assert.rejects(api.request('GET', '/vault/summary'), error => {
      assert.equal(error.message, 'The server returned an unexpected response. Refresh the page and try again.');
      assert.equal(/private-server-body|synthetic-api-token|<html>|JSON\.parse/.test(error.message), false);
      return true;
    });
  }
});

test('malformed JSON never exposes raw parse errors, body fragments or token values', async () => {
  for (const route of ['/notifications', '/vault/summary']) {
    const api = client(async () => new Response('{"private-server-body":"synthetic-api-token",bad', {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }));
    await assert.rejects(api.request('GET', route), error => {
      assert.equal(error.message, 'The server returned an unreadable response. Refresh the page and try again.');
      assert.equal(/private-server-body|synthetic-api-token|SyntaxError|JSON\.parse|Unexpected token/.test(error.message + error.stack), false);
      assert.equal(error.cause, undefined);
      return true;
    });
  }
});

test('JSON authentication and validation messages remain intact and invalid error envelopes are safe', async () => {
  for (const [status, message] of [[401, 'Current password required'], [400, 'Valid notification address required']]) {
    const api = client(async () => new Response(JSON.stringify({ error: message }), {
      status, headers: { 'Content-Type': 'application/json' },
    }));
    await assert.rejects(api.request('POST', '/notifications/test'), { message });
  }
  for (const body of ['null', '{}', '{"error":{"detail":"private-server-body"}}']) {
    const api = client(async () => new Response(body, { status: 500, headers: { 'Content-Type': 'application/json' } }));
    await assert.rejects(api.request('GET', '/vault/summary'), { message: 'Request failed' });
  }
});

test('structured JSON media types are parsed and successful arrays still pass through', async () => {
  const api = client(async () => new Response('[{"id":1}]', {
    headers: { 'Content-Type': 'Application/vnd.wolfs-legacy+json; charset=utf-8' },
  }), null);
  assert.deepEqual(await api.request('GET', '/beneficiaries'), [{ id: 1 }]);
});
