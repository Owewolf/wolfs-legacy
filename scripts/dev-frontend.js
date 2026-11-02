#!/usr/bin/env node
'use strict';

const path = require('path');
const express = require('express');

const app = express();

const host = process.env.DEV_FRONTEND_HOST || '127.0.0.1';
const port = Number(process.env.DEV_FRONTEND_PORT || 4444);
const apiTarget = (process.env.DEV_API_TARGET || 'http://127.0.0.1:3000').replace(/\/$/, '');

app.use(express.static(path.join(__dirname, '..', 'public')));

app.all('/api/*splat', async (req, res) => {
  try {
    const upstreamUrl = new URL(req.originalUrl, apiTarget).toString();
    const headers = new Headers();

    for (const [k, v] of Object.entries(req.headers)) {
      if (!v) continue;
      if (k.toLowerCase() === 'host') continue;
      if (Array.isArray(v)) {
        for (const item of v) headers.append(k, item);
      } else {
        headers.set(k, v);
      }
    }

    const method = req.method.toUpperCase();
    const hasBody = !['GET', 'HEAD'].includes(method);

    const upstream = await fetch(upstreamUrl, {
      method,
      headers,
      body: hasBody ? req : undefined,
      duplex: hasBody ? 'half' : undefined,
      redirect: 'manual'
    });

    res.status(upstream.status);
    upstream.headers.forEach((value, key) => {
      if (key.toLowerCase() === 'transfer-encoding') return;
      res.setHeader(key, value);
    });

    if (!upstream.body) {
      res.end();
      return;
    }

    for await (const chunk of upstream.body) {
      res.write(chunk);
    }
    res.end();
  } catch (err) {
    res.status(502).json({ error: 'Upstream API unavailable', detail: String(err && err.message ? err.message : err) });
  }
});

app.get('*splat', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.listen(port, host, () => {
  console.log(`Local frontend: http://${host}:${port}`);
  console.log(`API: ${apiTarget}`);
  console.log('Changes made through this frontend use the remote API target.');
});
