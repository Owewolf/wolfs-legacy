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
const crypto = require('node:crypto');
const { createFrontendServer, isSameMachineAddress, approvedLocalRequest } = require('../scripts/dev-frontend');

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
  const server = createFrontendServer({ apiTarget: target, publicRoot, localAuthConfigPath: path.join(root, 'absent-local-auth.json') });
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
    assert.throws(() => createFrontendServer({ apiTarget, publicRoot: f.publicRoot, localAuthConfigPath: path.join(f.root, 'absent-local-auth.json') }), /DEV_API_TARGET/);
  }
});

test('upstream failures return a bounded JSON error without exposing upstream details', async t => {
  const f = await fixture(t);
  const unused = http.createServer();
  const target = await listen(t, unused);
  await new Promise(resolve => unused.close(resolve));
  const origin = await listen(t, createFrontendServer({ apiTarget: target, publicRoot: f.publicRoot, localAuthConfigPath: path.join(f.root, 'absent-local-auth.json') }));
  const response = await fetch(origin + '/api/vault/entries');
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: 'The configured API is unavailable. Try again later.' });
});

test('an idle upstream times out without leaving the local browser request hanging', async t => {
  const f = await fixture(t, () => {});
  const origin = await listen(t, createFrontendServer({ apiTarget: f.target, publicRoot: f.publicRoot, apiTimeoutMs: 30, localAuthConfigPath: path.join(f.root, 'absent-local-auth.json') }));
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
  const server = createFrontendServer({ apiTarget: target, publicRoot: root, localAuthConfigPath: path.join(root, 'absent-local-auth.json') });
  const origin = await listen(t, server);
  const response = await fetch(origin + '/api/vault/entries');
  assert.equal(response.status, 502);
  assert.equal(calls, 0, 'An untrusted TLS endpoint must not receive the API request');
});

async function privateGatewayFixture(t, handler) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vault-private-gateway-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const publicRoot = path.join(root, 'public');
  const privateRoot = path.join(root, 'private-config');
  await fs.mkdir(publicRoot, { mode: 0o700 });
  await fs.mkdir(privateRoot, { mode: 0o700 });
  await fs.writeFile(path.join(publicRoot, 'index.html'), '<title>Synthetic gateway fixture</title>');
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-keyout', path.join(root, 'key.pem'), '-out', path.join(root, 'cert.pem'), '-subj', '/CN=localhost',
      '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  } catch (error) {
    if (error.code === 'ENOENT') { t.skip('OpenSSL unavailable for the private HTTPS gateway fixture'); return null; }
    throw error;
  }
  const cert = await fs.readFile(path.join(root, 'cert.pem'));
  const upstream = https.createServer({ key: await fs.readFile(path.join(root, 'key.pem')), cert }, handler);
  const target = (await listen(t, upstream)).replace('http:', 'https:');
  const configPath = path.join(privateRoot, 'local-auth.json');
  const config = { enabled: true, api_origin: target, gateway_id: 'a1'.repeat(16), secret: 'b2'.repeat(32) };
  await fs.writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  const options = { publicRoot, apiTarget: target, localAuthConfigPath: configPath, apiCa: cert };
  const origin = await listen(t, createFrontendServer(options));
  return { root, publicRoot, privateRoot, configPath, config, options, origin };
}

function verifyGatewayProof(headers, config, method, requestUrl) {
  assert.equal(headers['x-wolfs-local-gateway'], config.gateway_id);
  assert.match(headers['x-wolfs-local-nonce'], /^[a-f0-9]{32}$/);
  assert.match(headers['x-wolfs-local-time'], /^\d+$/);
  assert.ok(Math.abs(Date.now() - Number(headers['x-wolfs-local-time'])) < 30000);
  const authorizationHash = crypto.createHash('sha256').update(headers.authorization || '').digest('hex');
  const canonical = JSON.stringify(['v1', config.gateway_id, headers['x-wolfs-local-time'],
    headers['x-wolfs-local-nonce'], method, requestUrl, authorizationHash]);
  const expected = crypto.createHmac('sha256', Buffer.from(config.secret, 'hex')).update(canonical).digest('hex');
  assert.equal(headers['x-wolfs-local-signature'], expected);
}

test('private local gateway proofs bind exact method, URL and sanitized authorization over verified HTTPS', async t => {
  const seen = [];
  const f = await privateGatewayFixture(t, (request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      seen.push({ method: request.method, url: request.url, headers: request.headers, body: Buffer.concat(chunks).toString() });
      response.writeHead(200, { 'Content-Type': 'application/json', 'X-Wolfs-Local-Signature': 'must-not-reach-browser' });
      response.end('{"ok":true}');
    });
  });
  if (!f) return;
  const suffix = '/api/auth/login?synthetic=%2f&order=2&order=1';
  for (const headers of [
    { Authorization: 'Bearer synthetic-owner-session', Origin: f.origin, 'Sec-Fetch-Site': 'same-origin' },
    { Authorization: 'Bearer synthetic-discarded-session', Connection: 'authorization' },
  ]) {
    const result = await rawRequest(f.origin, suffix, { method: 'POST', headers: { ...headers,
      'Content-Type': 'application/json', 'X-Wolfs-Local-Gateway': 'forged', 'X-Wolfs-Local-Time': '1',
      'X-Wolfs-Local-Nonce': 'forged', 'X-Wolfs-Local-Signature': 'forged', 'X-Wolfs-Local-Secret': 'forged-secret' }, body: '{"password":"synthetic"}' });
    assert.equal(result.status, 200);
    assert.equal(result.headers['x-wolfs-local-signature'], undefined);
    assert.deepEqual(JSON.parse(result.body), { ok: true });
  }
  assert.equal(seen.length, 2);
  for (const item of seen) {
    assert.equal(item.url, suffix);
    assert.equal(item.body, '{"password":"synthetic"}');
    assert.equal(item.headers['x-wolfs-local-secret'], undefined);
    verifyGatewayProof(item.headers, f.config, 'POST', suffix);
  }
  assert.equal(seen[1].headers.authorization, undefined, 'Hop-by-hop removal precedes authorization hashing');
  assert.notEqual(seen[0].headers['x-wolfs-local-nonce'], seen[1].headers['x-wolfs-local-nonce']);
});

test('local gateway refuses foreign origins, DNS rebinding hosts, cross-site requests and duplicate credentials', async t => {
  let calls = 0;
  const f = await privateGatewayFixture(t, (request, response) => { calls++; response.end('{}'); });
  if (!f) return;
  const rejectedHeaders = [
    { Host: 'unrecognized-attacker.invalid:4444' },
    { Origin: 'https://foreign-origin.invalid' },
    { Origin: 'null' },
    { Referer: 'https://foreign-origin.invalid/path' },
    { 'Sec-Fetch-Site': 'cross-site' },
  ];
  for (const headers of rejectedHeaders) {
    const response = await rawRequest(f.origin, '/api/auth/login', { method: 'POST', headers });
    assert.equal(response.status, 403);
    assert.doesNotMatch(response.body.toString(), new RegExp(f.config.secret + '|' + f.config.gateway_id));
  }
  const duplicate = await rawRequest(f.origin, '/api/auth/login', { headers: [
    ['Host', new URL(f.origin).host], ['Authorization', 'Bearer first'], ['aUtHoRiZaTiOn', 'Bearer second']
  ] });
  assert.equal(duplicate.status, 403);
  assert.equal(calls, 0, 'Unsafe local browser requests never reach the gateway-enabled upstream');
  const accepted = await rawRequest(f.origin, '/api/auth/login', { headers: { Origin: f.origin, Referer: f.origin + '/#login' } });
  assert.equal(accepted.status, 200);
  assert.equal(calls, 1);
});

test('gateway signing preserves streaming multipart uploads before upload completion', async t => {
  let firstChunk;
  const firstData = new Promise(resolve => { firstChunk = resolve; });
  let received;
  const f = await privateGatewayFixture(t, (request, response) => {
    const chunks = [];
    request.on('data', chunk => { chunks.push(chunk); firstChunk(); });
    request.on('end', () => { received = { headers: request.headers, body: Buffer.concat(chunks) }; response.end('{}'); });
  });
  if (!f) return;
  const target = new URL(f.origin);
  let client;
  const result = new Promise((resolve, reject) => {
    client = http.request({ hostname: target.hostname, port: target.port, path: '/api/documents/upload?synthetic=1', method: 'POST',
      headers: { Authorization: 'Bearer synthetic-upload-session', 'Content-Type': 'multipart/form-data; boundary=synthetic' } }, response => {
      response.resume(); response.on('end', resolve);
    });
    client.on('error', reject);
  });
  t.after(() => client.destroy());
  const first = Buffer.from('--synthetic\r\nContent-Disposition: form-data; name="file"; filename="fake.bin"\r\n\r\n');
  const last = Buffer.concat([Buffer.alloc(65536, 128), Buffer.from('\r\n--synthetic--\r\n')]);
  client.write(first);
  await Promise.race([firstData, new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error('Signed multipart upload was buffered')), 2000);
    timer.unref(); firstData.then(() => clearTimeout(timer));
  })]);
  client.end(last); await result;
  assert.deepEqual(received.body, Buffer.concat([first, last]));
  verifyGatewayProof(received.headers, f.config, 'POST', '/api/documents/upload?synthetic=1');
});

test('private configuration fails closed on exposure, bad permissions, symlinks, malformed values and origin changes', async t => {
  const f = await privateGatewayFixture(t, (request, response) => response.end('{}'));
  if (!f) return;
  const invalid = () => assert.throws(() => createFrontendServer(f.options), error => {
    assert.equal(error.message, 'Private local authentication configuration is invalid');
    assert.ok(!error.message.includes(f.config.secret)); return true;
  });
  await fs.chmod(f.configPath, 0o644); invalid(); await fs.chmod(f.configPath, 0o600);
  await fs.chmod(f.privateRoot, 0o755); invalid(); await fs.chmod(f.privateRoot, 0o700);
  const source = path.join(f.privateRoot, 'source.json');
  await fs.rename(f.configPath, source); await fs.symlink(source, f.configPath); invalid();
  await fs.unlink(f.configPath); await fs.rename(source, f.configPath);
  const linkedRoot = path.join(f.root, 'linked-private'); await fs.symlink(f.privateRoot, linkedRoot);
  assert.throws(() => createFrontendServer({ ...f.options, localAuthConfigPath: path.join(linkedRoot, 'local-auth.json') }), /configuration is invalid/);
  for (const content of ['{not valid JSON', JSON.stringify({ ...f.config, secret: 'not-a-secret' }),
    JSON.stringify({ ...f.config, gateway_id: 'bad-id' }), JSON.stringify({ ...f.config, api_origin: 'http://127.0.0.1' }),
    JSON.stringify({ ...f.config, api_origin: 'https://other-origin.invalid' }), ' '.repeat(4097)]) {
    await fs.writeFile(f.configPath, content); invalid();
  }
  await fs.writeFile(f.configPath, JSON.stringify(f.config));
  assert.throws(() => createFrontendServer({ ...f.options, apiTarget: 'http://127.0.0.1' }), /configuration is invalid/);
  assert.throws(() => createFrontendServer({ ...f.options, publicRoot: f.privateRoot }), /configuration is invalid/);
  if (process.getuid() === 0) {
    await fs.chown(f.configPath, 1, 1); invalid(); await fs.chown(f.configPath, 0, 0);
  }
});

test('absent or explicitly disabled local configuration forwards normally and strips all forged proof headers', async t => {
  const seen = [];
  const f = await fixture(t, (request, response) => { seen.push(request.headers); response.end('{}'); });
  await rawRequest(f.origin, '/api/auth/login', { headers: { 'X-Wolfs-Local-Signature': 'forged', 'X-Wolfs-Local-Anything': 'forged', Host: 'ordinary-lan-client.invalid' } });
  const directory = path.join(f.root, 'disabled-config'); await fs.mkdir(directory, { mode: 0o700 });
  const configPath = path.join(directory, 'local-auth.json'); await fs.writeFile(configPath, '{"enabled":false}', { mode: 0o600 });
  const disabled = await listen(t, createFrontendServer({ apiTarget: f.target, publicRoot: f.publicRoot, localAuthConfigPath: configPath }));
  await rawRequest(disabled, '/api/auth/login', { headers: { 'X-Wolfs-Local-Gateway': 'forged', 'X-Wolfs-Local-Secret': 'forged' } });
  assert.equal(seen.length, 2);
  assert.ok(seen.every(headers => Object.keys(headers).every(name => !name.startsWith('x-wolfs-local-'))));
});

test('same-machine eligibility uses actual socket addresses and own interfaces, never forwarded identities', () => {
  const interfaces = { lo: [{ address: '127.0.0.1' }, { address: '::1' }], eth0: [{ address: '192.0.2.7' }, { address: '2001:db8::7' }] };
  for (const address of ['127.0.0.1', '127.42.1.2', '::1', '::ffff:127.0.0.1', '192.0.2.7', '::ffff:192.0.2.7', '2001:db8:0:0::7']) {
    assert.equal(isSameMachineAddress(address, interfaces), true, address);
  }
  for (const address of ['192.0.2.8', '203.0.113.2', '2001:db8::8', 'not-an-address', '127.0.0.999', undefined]) {
    assert.equal(isSameMachineAddress(address, interfaces), false, String(address));
  }
  const request = { socket: { remoteAddress: '192.0.2.8' }, headers: { host: 'asus.local:4444', 'x-forwarded-for': '127.0.0.1', forwarded: 'for=127.0.0.1' } };
  assert.equal(approvedLocalRequest(request, interfaces, 'asus'), false);
  request.socket.remoteAddress = '192.0.2.7';
  assert.equal(approvedLocalRequest(request, interfaces, 'asus'), true, 'same computer can use its own LAN address and hostname');
  request.headers.host = 'attacker.invalid:4444';
  assert.equal(approvedLocalRequest(request, interfaces, 'asus'), false);
  request.headers.host = '192.0.2.7:4444';
  request.headers.origin = 'http://192.0.2.7:4444';
  assert.equal(approvedLocalRequest(request, interfaces, 'asus'), true);
  request.headers.origin = 'http://asus.local:4444';
  assert.equal(approvedLocalRequest(request, interfaces, 'asus'), false);
});
