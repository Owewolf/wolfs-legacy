'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const { initSmsOtpSchema } = require('../server/sms-otp');
const { createAuthRouter } = require('../server/routes/auth');

function createDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      totp_secret TEXT,
      totp_enabled INTEGER DEFAULT 0,
      sms_2fa_phone_e164 TEXT,
      sms_2fa_enabled INTEGER DEFAULT 0,
      sms_2fa_enrolled_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_check_in DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE dead_switch_config (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL UNIQUE,
      check_in_interval_days INTEGER DEFAULT 30,
      grace_period_days INTEGER DEFAULT 7,
      is_active INTEGER DEFAULT 0,
      switch_triggered INTEGER DEFAULT 0,
      switch_triggered_at DATETIME
    );
    CREATE TABLE audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      action TEXT NOT NULL,
      target_type TEXT,
      target_id INTEGER,
      detail TEXT,
      ip_address TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  initSmsOtpSchema(db);
  return db;
}

async function createServer(db, smsProvider, env = {}) {
  const app = express();
  app.use(express.json());
  app.locals.getDb = () => db;
  const mergedEnv = {
    JWT_SECRET: 'test-secret',
    OTP_HASH_KEY: 'z'.repeat(32),
    ENCRYPTION_KEY: 'a'.repeat(64),
    ...env
  };
  process.env.JWT_SECRET = mergedEnv.JWT_SECRET;
  app.use('/api/auth', createAuthRouter({
    dbGetter: () => db,
    env: mergedEnv,
    smsProvider
  }));
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  return server;
}

async function requestJson(server, method, path, body, token) {
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json();
  return { status: res.status, data };
}

test('register does not auto-issue jwt', async () => {
  const db = createDb();
  const smsProvider = { configured: true, sendOtp: async () => ({}) };
  const server = await createServer(db, smsProvider);

  try {
    const res = await requestJson(server, 'POST', '/api/auth/register', {
      email: 'owner@example.test',
      name: 'Owner',
      password: 'StrongPass123!'
    });
    assert.equal(res.status, 201);
    assert.equal(Boolean(res.data.token), false);
    assert.equal(res.data.success, true);
  } finally {
    server.close();
    db.close();
  }
});

test('2fa-enabled login requires challenge and delays jwt', async () => {
  const db = createDb();
  const passwordHash = await bcrypt.hash('StrongPass123!', 12);
  db.prepare('INSERT INTO users(email,password_hash,name,sms_2fa_enabled,sms_2fa_phone_e164) VALUES(?,?,?,?,?)')
    .run('owner@example.test', passwordHash, 'Owner', 1, '+27821239999');

  const sent = [];
  const smsProvider = {
    configured: true,
    async sendOtp(payload) {
      sent.push(payload);
      return {};
    }
  };

  const server = await createServer(db, smsProvider);
  try {
    const step1 = await requestJson(server, 'POST', '/api/auth/login', {
      email: 'owner@example.test',
      password: 'StrongPass123!'
    });
    assert.equal(step1.status, 200);
    assert.equal(step1.data.requires_second_factor, true);
    assert.equal(Boolean(step1.data.token), false);
    assert.equal(sent.length, 1);

    const otp = sent[0].message.match(/(\d{6})/)[1];
    const step2 = await requestJson(server, 'POST', '/api/auth/login/challenge/verify', {
      challenge_id: step1.data.challenge_id,
      challenge_token: step1.data.challenge_token,
      otp
    });
    assert.equal(step2.status, 200);
    assert.equal(typeof step2.data.token, 'string');
  } finally {
    server.close();
    db.close();
  }
});

test('2fa enrollment endpoints work with authenticated user', async () => {
  const db = createDb();
  const passwordHash = await bcrypt.hash('StrongPass123!', 12);
  const r = db.prepare('INSERT INTO users(email,password_hash,name) VALUES(?,?,?)').run('owner@example.test', passwordHash, 'Owner');
  db.prepare('INSERT INTO dead_switch_config(user_id) VALUES(?)').run(r.lastInsertRowid);

  const sent = [];
  const smsProvider = {
    configured: true,
    async sendOtp(payload) {
      sent.push(payload);
      return {};
    }
  };

  const server = await createServer(db, smsProvider);
  try {
    const login = await requestJson(server, 'POST', '/api/auth/login', {
      email: 'owner@example.test',
      password: 'StrongPass123!'
    });
    assert.equal(login.status, 200);
    const token = login.data.token;

    const start = await requestJson(server, 'POST', '/api/auth/2fa/enroll/start', {
      phone: '+27821230088',
      current_password: 'StrongPass123!'
    }, token);
    assert.equal(start.status, 200);
    assert.equal(sent.length, 1);

    const otp = sent[0].message.match(/(\d{6})/)[1];
    const verify = await requestJson(server, 'POST', '/api/auth/2fa/enroll/verify', {
      challenge_id: start.data.challenge_id,
      challenge_token: start.data.challenge_token,
      otp
    }, token);
    assert.equal(verify.status, 200);
    assert.equal(Array.isArray(verify.data.recovery_codes), true);
    assert.equal(verify.data.recovery_codes.length, 10);

    const me = db.prepare('SELECT sms_2fa_enabled FROM users WHERE id=?').get(r.lastInsertRowid);
    assert.equal(me.sms_2fa_enabled, 1);
  } finally {
    server.close();
    db.close();
  }
});
