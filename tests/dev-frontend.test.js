'use strict';

// Fake loopback upstreams and temporary files only; no app initialization,
// environment files, production API, database, credentials or personal records.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { once } = require('node:events');
const { execFileSync } = require('node:child_process');
const { createFrontendServer } = require('../scripts/dev-frontend');

async function listen(t, server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => {
    server.closeAllConnections();
    server.close(resolve);
  }));
  return `http://127.0.0.1:${server.address().port}`;
}

async function fixture(t, handler) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vault-frontend-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const publicRoot = path.join(root, 'public');
  await fs.mkdir(publicRoot);
  await fs.writeFile(path.join(publicRoot, 'index.html'), '<!doctype html><title>Synthetic frontend</title>');
  await fs.writeFile(path.join(publicRoot, 'app.js'), 'window.syntheticFrontend = true;');
  await fs.writeFile(path.join(root, '.env'), 'SYNTHETIC_PRIVATE_SETTING=never_serve');
  const upstream = http.createServer(handler || ((request, response) => response.end('{}')));
  const target = await listen(t, upstream);
  const server = createFrontendServer({ apiTarget: target, publicRoot });
  const origin = await listen(t, server);
  return { root, publicRoot, target, origin, server };
}

function rawRequest(origin, requestPath, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(origin);
    const request = http.request({ hostname: url.hostname, port: url.port,
      path: requestPath, ...options }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    request.on('error', reject);
    request.end(options.body);
  });
}

test('the frontend server serves only public files without loading application or database modules', async t => {
  const f = await fixture(t);
  const home = await fetch(f.origin + '/');
  assert.equal(home.status, 200);
  assert.match(home.headers.get('content-type'), /text\/html/);
  assert.match(await home.text(), /Synthetic frontend/);
  const script = await fetch(f.origin + '/app.js');
  assert.match(script.headers.get('content-type'), /javascript/);
  assert.equal(await script.text(), 'window.syntheticFrontend = true;');
  const head = await fetch(f.origin + '/app.js', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  const post = await fetch(f.origin + '/', { method: 'POST', body: 'synthetic' });
  assert.equal(post.status, 405);
  assert.equal(post.headers.get('allow'), 'GET, HEAD');
  for (const loaded of Object.keys(require.cache)) {
    assert.ok(!loaded.startsWith(path.resolve(__dirname, '../server') + path.sep), 'Application modules must remain unloaded');
  }
});

test('private paths, traversal and symlink escapes cannot serve files outside public', async t => {
  const f = await fixture(t);
  await fs.symlink(path.join(f.root, '.env'), path.join(f.publicRoot, 'outside.txt'));
  for (const requestPath of ['/.env', '/../.env', '/%2e%2e/.env', '/%2eenv', '/outside.txt', '/bad%00path', '/bad\\path']) {
    const response = await rawRequest(f.origin, requestPath);
    assert.equal(response.status, 404, requestPath);
    assert.doesNotMatch(response.body.toString(), /never_serve/);
  }
  assert.equal((await rawRequest(f.origin, '/bad%ZZ')).status, 400);
});

test('API forwarding preserves authorization, query, methods, JSON errors and upstream status', async t => {
  const seen = [];
  const f = await fixture(t, (request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      seen.push({ method: request.method, url: request.url, headers: request.headers, body: Buffer.concat(chunks).toString() });
      response.writeHead(403, { 'Content-Type': 'application/json', 'X-Synthetic-Upstream': 'preserved' });
      response.end('{"error":"Synthetic denial"}');
    });
  });
  const response = await fetch(f.origin + '/api/final-wishes/legacy?status=draft', {
    method: 'PATCH', headers: { Authorization: 'Bearer synthetic-token', 'Content-Type': 'application/json',
      Forwarded: 'for=synthetic', 'X-Forwarded-For': '192.0.2.12' }, body: '{"title":"Synthetic wish"}'
  });
  assert.equal(response.status, 403);
  assert.equal(response.headers.get('x-synthetic-upstream'), 'preserved');
  assert.deepEqual(await response.json(), { error: 'Synthetic denial' });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].method, 'PATCH');
  assert.equal(seen[0].url, '/api/final-wishes/legacy?status=draft');
  assert.equal(seen[0].headers.authorization, 'Bearer synthetic-token');
  assert.equal(seen[0].headers.host, new URL(f.target).host);
  assert.equal(seen[0].headers.forwarded, undefined);
  assert.equal(seen[0].headers['x-forwarded-for'], undefined);
  assert.equal(seen[0].body, '{"title":"Synthetic wish"}');
});

test('multipart bodies stream before upload completion and binary range responses preserve their headers', async t => {
  let firstChunk;
  const firstData = new Promise(resolve => { firstChunk = resolve; });
  let received;
  const binary = Buffer.from([0, 255, 128, 13, 10, 0, 42]);
  const f = await fixture(t, (request, response) => {
    const chunks = [];
    request.on('data', chunk => { chunks.push(chunk); firstChunk(); });
    request.on('end', () => {
      received = { headers: request.headers, body: Buffer.concat(chunks) };
      response.writeHead(206, { 'Content-Type': 'application/octet-stream', 'Content-Range': 'bytes 10-16/100',
        'Content-Length': binary.length, 'Content-Disposition': 'attachment; filename="synthetic.bin"',
        'Accept-Ranges': 'bytes', 'Set-Cookie': ['synthetic=a; HttpOnly', 'synthetic-b=b; HttpOnly'] });
      response.end(binary);
    });
  });
  const start = Buffer.from('--synthetic-boundary\r\nContent-Disposition: form-data; name="file"; filename="synthetic.bin"\r\n\r\n');
  const end = Buffer.concat([Buffer.alloc(16384, 128), Buffer.from('\r\n--synthetic-boundary--\r\n')]);
  const contentType = 'multipart/form-data; boundary=synthetic-boundary';
  const url = new URL(f.origin);
  let client;
  const result = new Promise((resolve, reject) => {
    client = http.request({ hostname: url.hostname, port: url.port, path: '/api/documents/upload', method: 'POST',
      headers: { 'Content-Type': contentType, Authorization: 'Bearer synthetic-upload-token', Range: 'bytes=10-16' } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    client.on('error', reject);
  });
  t.after(() => client.destroy());
  client.write(start);
  await Promise.race([firstData, new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error('Upload was buffered instead of streamed')), 2000);
    timer.unref();
    firstData.then(() => clearTimeout(timer));
  })]);
  client.end(end);
  const response = await result;
  assert.deepEqual(received.body, Buffer.concat([start, end]));
  assert.equal(received.headers['content-type'], contentType);
  assert.equal(received.headers.authorization, 'Bearer synthetic-upload-token');
  assert.equal(received.headers.range, 'bytes=10-16');
  assert.equal(response.status, 206);
  assert.deepEqual(response.body, binary);
  assert.equal(response.headers['content-range'], 'bytes 10-16/100');
  assert.equal(response.headers['content-disposition'], 'attachment; filename="synthetic.bin"');
  assert.equal(response.headers['accept-ranges'], 'bytes');
  assert.equal(response.headers['set-cookie'].length, 2);
});

test('the proxy uses only its configured origin and returns redirects without following them', async t => {
  let calls = 0;
  const f = await fixture(t, (request, response) => {
    calls++;
    response.writeHead(302, { Location: 'https://uncontacted.example.test/redirect-target' });
    response.end();
  });
  const redirected = await fetch(f.origin + '/api/redirect', { redirect: 'manual' });
  assert.equal(redirected.status, 302);
  assert.equal(redirected.headers.get('location'), 'https://uncontacted.example.test/redirect-target');
  assert.equal((await rawRequest(f.origin, 'http://uncontacted.example.test/api/secret')).status, 400);
  assert.equal((await rawRequest(f.origin, '//uncontacted.example.test/api/secret')).status, 400);
  assert.equal(calls, 1);
  for (const apiTarget of ['http://uncontacted.example.test', 'ftp://127.0.0.1',
    'https://user:password@example.test', 'https://example.test/api', 'https://example.test/?target=other']) {
    assert.throws(() => createFrontendServer({ apiTarget, publicRoot: f.publicRoot }), /DEV_API_TARGET/);
  }
});

test('upstream failures return a bounded JSON error without exposing upstream details', async t => {
  const f = await fixture(t);
  const unused = http.createServer();
  const target = await listen(t, unused);
  await new Promise(resolve => unused.close(resolve));
  const origin = await listen(t, createFrontendServer({ apiTarget: target, publicRoot: f.publicRoot }));
  const response = await fetch(origin + '/api/vault/entries');
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: 'The configured API is unavailable. Try again later.' });
});

test('an idle upstream times out without leaving the local browser request hanging', async t => {
  const f = await fixture(t, () => {});
  const origin = await listen(t, createFrontendServer({ apiTarget: f.target, publicRoot: f.publicRoot, apiTimeoutMs: 30 }));
  const response = await fetch(origin + '/api/vault/entries');
  assert.equal(response.status, 504);
  assert.deepEqual(await response.json(), { error: 'The configured API is unavailable. Try again later.' });
});

test('HTTPS upstream certificates are verified rather than accepting a self-signed endpoint', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vault-frontend-tls-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-keyout', path.join(root, 'key.pem'), '-out', path.join(root, 'cert.pem'), '-subj', '/CN=localhost',
      '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  } catch (error) {
    if (error.code === 'ENOENT') { t.skip('OpenSSL is unavailable for the synthetic certificate fixture'); return; }
    throw error;
  }
  let calls = 0;
  const upstream = https.createServer({ key: await fs.readFile(path.join(root, 'key.pem')),
    cert: await fs.readFile(path.join(root, 'cert.pem')) }, (request, response) => { calls++; response.end('{}'); });
  const target = (await listen(t, upstream)).replace('http:', 'https:');
  const server = createFrontendServer({ apiTarget: target, publicRoot: root });
  const origin = await listen(t, server);
  const response = await fetch(origin + '/api/vault/entries');
  assert.equal(response.status, 502);
  assert.equal(calls, 0, 'An untrusted TLS endpoint must not receive the API request');
});
