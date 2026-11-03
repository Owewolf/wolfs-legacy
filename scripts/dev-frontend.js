#!/usr/bin/env node
'use strict';

// Frontend only: never load the application, its environment file or database.
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const DEFAULT_TARGET = 'https://wolfspack.co.za';
const HOP_HEADERS = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade'];
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon' };

function targetOrigin(value) {
  const target = new URL(value);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname);
  if (!(target.protocol === 'https:' || (target.protocol === 'http:' && local)) ||
      target.username || target.password || target.pathname !== '/' || target.search || target.hash) {
    throw new Error('DEV_API_TARGET must be an HTTPS origin; HTTP is allowed only for loopback fixtures');
  }
  return target;
}

function endToEndHeaders(headers) {
  const clean = { ...headers };
  const connection = String(headers.connection || '').split(',').map(value => value.trim().toLowerCase());
  for (const name of [...HOP_HEADERS, ...connection]) delete clean[name];
  for (const name of Object.keys(clean)) if (name.toLowerCase().startsWith('x-wolfs-local-')) delete clean[name];
  return clean;
}


const PRIVATE_CONFIG_ERROR = 'Private local authentication configuration is invalid';

function readLocalAuthConfig(filename, target) {
  let stat;
  try { stat = fs.lstatSync(filename); }
  catch (error) { if (error.code === 'ENOENT') return null; throw new Error(PRIVATE_CONFIG_ERROR); }
  let descriptor;
  try {
    const parent = fs.lstatSync(path.dirname(filename));
    const uid = process.getuid?.();
    if (uid === undefined || !parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== uid ||
        (parent.mode & 0o7777) !== 0o700 || !stat.isFile() || stat.isSymbolicLink() || stat.uid !== uid ||
        (stat.mode & 0o7777) !== 0o600 || stat.size > 4096) throw new Error();
    descriptor = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.uid !== uid || (opened.mode & 0o7777) !== 0o600 ||
        opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size > 4096) throw new Error();
    const config = JSON.parse(fs.readFileSync(descriptor, 'utf8'));
    if (!config || Array.isArray(config) || typeof config.enabled !== 'boolean') throw new Error();
    if (config.enabled === false) return null;
    if (typeof config.api_origin !== 'string' || typeof config.gateway_id !== 'string' ||
        !/^[a-f0-9]{32}$/i.test(config.gateway_id) || typeof config.secret !== 'string' ||
        !/^[a-f0-9]{64}$/i.test(config.secret)) throw new Error();
    const origin = targetOrigin(config.api_origin);
    if (origin.protocol !== 'https:' || target.protocol !== 'https:' || origin.origin !== target.origin) throw new Error();
    return { gatewayId: config.gateway_id, secret: Buffer.from(config.secret, 'hex') };
  } catch { throw new Error(PRIVATE_CONFIG_ERROR); }
  finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}

function addressKey(value) {
  if (typeof value !== 'string') return null;
  let address = value.toLowerCase().split('%', 1)[0];
  if (/^::ffff:\d+\.\d+\.\d+\.\d+$/.test(address)) address = address.slice(7);
  if (/^\d+\.\d+\.\d+\.\d+$/.test(address)) {
    const parts = address.split('.').map(Number);
    return parts.every(part => part >= 0 && part <= 255) ? parts.join('.') : null;
  }
  try {
    address = new URL('http://[' + address + ']/').hostname.slice(1, -1);
    const mapped = /^::ffff:([a-f0-9]+):([a-f0-9]+)$/.exec(address);
    if (mapped) {
      const first = parseInt(mapped[1], 16), last = parseInt(mapped[2], 16);
      return [first >> 8, first & 255, last >> 8, last & 255].join('.');
    }
    return address;
  } catch { return null; }
}

function isSameMachineAddress(remoteAddress, interfaces = os.networkInterfaces()) {
  const address = addressKey(remoteAddress);
  if (!address) return false;
  if (address === '::1' || address.startsWith('127.')) return true;
  return Object.values(interfaces).flat().some(item => addressKey(item?.address) === address);
}

function approvedLocalRequest(request, interfaces = os.networkInterfaces(), hostname = os.hostname()) {
  if (!isSameMachineAddress(request.socket.remoteAddress, interfaces)) return false;
  const host = request.headers.host;
  if (typeof host !== 'string' || /[\s/@?#\\]/.test(host)) return false;
  let authority;
  try { authority = new URL('http://' + host); }
  catch { return false; }
  if (authority.pathname !== '/' || authority.username || authority.password || authority.search || authority.hash) return false;
  const rawHostname = authority.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const names = new Set(['localhost', hostname.toLowerCase(), hostname.toLowerCase() + '.local', hostname.toLowerCase().split('.')[0] + '.local']);
  if (!names.has(rawHostname) && !isSameMachineAddress(rawHostname, interfaces)) return false;
  if (String(request.headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') return false;
  const scheme = request.socket.encrypted ? 'https:' : 'http:';
  const localOrigin = scheme + '//' + authority.host;
  if (request.headers.origin !== undefined && request.headers.origin !== localOrigin) return false;
  if (request.headers.referer !== undefined) {
    try { if (new URL(request.headers.referer).origin !== localOrigin) return false; }
    catch { return false; }
  }
  const raw = request.rawHeaders || [];
  for (const name of ['authorization', 'host']) {
    let count = 0;
    for (let index = 0; index < raw.length; index += 2) if (raw[index].toLowerCase() === name) count++;
    if (count > 1) return false;
  }
  return true;
}

function signedLocalHeaders(config, method, requestUrl, authorization = '') {
  const timestamp = String(Date.now()), nonce = crypto.randomBytes(16).toString('hex');
  const authorizationHash = crypto.createHash('sha256').update(authorization).digest('hex');
  const message = JSON.stringify(['v1', config.gatewayId, timestamp, nonce, method.toUpperCase(), requestUrl, authorizationHash]);
  return { 'x-wolfs-local-gateway': config.gatewayId, 'x-wolfs-local-time': timestamp,
    'x-wolfs-local-nonce': nonce,
    'x-wolfs-local-signature': crypto.createHmac('sha256', config.secret).update(message).digest('hex') };
}

function jsonError(response, status, message) {
  if (response.destroyed) return;
  if (response.headersSent) { response.destroy(); return; }
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify({ error: message }));
}

function createFrontendServer(options = {}) {
  const target = targetOrigin(options.apiTarget ?? process.env.DEV_API_TARGET ?? DEFAULT_TARGET);
  const publicRoot = fs.realpathSync(options.publicRoot || path.resolve(__dirname, '../public'));
  const withinPublic = filename => filename === publicRoot || filename.startsWith(publicRoot + path.sep);
  const transport = target.protocol === 'https:' ? https : http;
  const timeout = options.apiTimeoutMs ?? 30000;
  const configPath = options.localAuthConfigPath ?? path.join(os.homedir(), '.config/wolfs-legacy/local-auth.json');
  const localAuth = readLocalAuthConfig(configPath, target);
  try {
    if (withinPublic(fs.realpathSync(configPath))) throw new Error(PRIVATE_CONFIG_ERROR);
  } catch (error) { if (error.code !== 'ENOENT') throw new Error(PRIVATE_CONFIG_ERROR); }

  return http.createServer(async (request, response) => {
    // Ignore neither the request's authority nor its scheme: reject them. The
    // upstream origin always comes exclusively from the operator's setting.
    if (!request.url.startsWith('/') || request.url.startsWith('//')) {
      jsonError(response, 400, 'Use a local application path'); return;
    }
    if (/^\/api(?:\/|\?|$)/.test(request.url)) {
      const headers = endToEndHeaders(request.headers);
      headers.host = target.host;
      for (const name of Object.keys(headers)) {
        if (name === 'forwarded' || name.startsWith('x-forwarded-')) delete headers[name];
      }
      if (localAuth && isSameMachineAddress(request.socket.remoteAddress)) {
        if (!approvedLocalRequest(request)) { jsonError(response, 403, 'Local authentication requires a same-machine application request'); return; }
        Object.assign(headers, signedLocalHeaders(localAuth, request.method, request.url, headers.authorization || ''));
      }
      const upstream = transport.request({ protocol: target.protocol, hostname: target.hostname.replace(/^\[|\]$/g, ''),
        port: target.port || undefined, method: request.method, path: request.url, headers,
        rejectUnauthorized: true, ...(options.apiCa ? { ca: options.apiCa } : {}) }, upstreamResponse => {
        response.writeHead(upstreamResponse.statusCode, endToEndHeaders(upstreamResponse.headers));
        upstreamResponse.on('error', () => response.destroy());
        upstreamResponse.pipe(response);
      });
      upstream.setTimeout(timeout, () => {
        upstream.destroy(Object.assign(new Error('API timeout'), { code: 'DEV_API_TIMEOUT' }));
      });
      upstream.on('error', error => jsonError(response, error.code === 'DEV_API_TIMEOUT' ? 504 : 502,
        'The configured API is unavailable. Try again later.'));
      request.on('aborted', () => upstream.destroy());
      request.on('error', () => upstream.destroy());
      response.on('close', () => { if (!response.writableEnded) upstream.destroy(); });
      request.pipe(upstream);
      return;
    }
    if (!['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(405, { Allow: 'GET, HEAD' }); response.end(); return;
    }
    try {
      const pathname = decodeURIComponent(request.url.split('?', 1)[0]);
      if (pathname.includes('\0') || pathname.includes('\\') || pathname.split('/').some(segment => segment.startsWith('.'))) {
        response.writeHead(404); response.end(); return;
      }
      const candidate = path.resolve(publicRoot, '.' + (pathname === '/' ? '/index.html' : pathname));
      if (!withinPublic(candidate)) { response.writeHead(404); response.end(); return; }
      const filename = await fs.promises.realpath(candidate);
      if (!withinPublic(filename)) { response.writeHead(404); response.end(); return; }
      const stat = await fs.promises.stat(filename);
      if (!stat.isFile()) { response.writeHead(404); response.end(); return; }
      response.writeHead(200, { 'Content-Type': MIME[path.extname(filename).toLowerCase()] || 'application/octet-stream',
        'Content-Length': stat.size, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      if (request.method === 'HEAD') { response.end(); return; }
      const stream = fs.createReadStream(filename);
      stream.on('error', () => response.destroy());
      response.on('close', () => stream.destroy());
      stream.pipe(response);
    } catch (error) {
      response.writeHead(error instanceof URIError ? 400 : 404); response.end();
    }
  });
}

if (require.main === module) {
  try {
    const port = Number(process.env.DEV_FRONTEND_PORT || 5173);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('DEV_FRONTEND_PORT must be between 1 and 65535');
    const host = process.env.DEV_FRONTEND_HOST || '127.0.0.1';
    const target = targetOrigin(process.env.DEV_API_TARGET || DEFAULT_TARGET);
    const server = createFrontendServer({ apiTarget: target.href });
    server.on('error', error => { process.stderr.write(`Frontend server could not start (${error.code || 'configuration'}).\n`); process.exitCode = 1; });
    server.listen(port, host, () => {
      process.stdout.write(`Local frontend: http://${host}:${port}\nAPI: ${target.origin}\nChanges made through this frontend use that API's live data.\n`);
    });
    const stop = () => server.close(() => { process.exitCode = 0; });
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  } catch (error) {
    process.stderr.write(`Frontend configuration error: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { createFrontendServer, isSameMachineAddress, approvedLocalRequest };
