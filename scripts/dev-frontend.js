#!/usr/bin/env node
'use strict';

// Frontend only: never load the application, its environment file or database.
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');

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
  return clean;
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
      const upstream = transport.request({ protocol: target.protocol, hostname: target.hostname.replace(/^\[|\]$/g, ''),
        port: target.port || undefined, method: request.method, path: request.url, headers,
        rejectUnauthorized: true }, upstreamResponse => {
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

module.exports = { createFrontendServer };
