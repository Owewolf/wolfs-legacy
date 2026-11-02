'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { normalizeAuthPhone, resolveSavedPhone } = require('../server/sms-auth-policy');

test('authentication phones normalize explicit international and local South African formats', () => {
  for (const phone of ['+27 82 123 4567', '0027821234567', '(082) 123-4567']) {
    assert.equal(normalizeAuthPhone(phone, { SMS_DEFAULT_COUNTRY_CODE: '27' }), '+27821234567');
  }
  assert.equal(normalizeAuthPhone('+447700900123'), '+447700900123');
  for (const phone of [null, {}, '', 'abc', '123', '27821234567', '08212345670000000000']) {
    assert.equal(normalizeAuthPhone(phone), null);
  }
});

test('verified authentication phones never fall back to profiles or explicit phone setup', () => {
  const db = new Database(':memory:');
  try {
    db.exec('CREATE TABLE vault_entries(user_id INTEGER,section TEXT,fields_encrypted TEXT)');
    db.prepare('INSERT INTO vault_entries VALUES(?,?,?)').run(1, 'personal', JSON.stringify({ mobile_phone: '+27821234567' }));
    assert.deepEqual(resolveSavedPhone(db, { id: 1, sms_2fa_enabled: 1, sms_2fa_phone_e164: 'invalid' }, {}, value => value), {
      phone: null, reason: 'enrolled_phone_unavailable'
    });
    assert.deepEqual(resolveSavedPhone(db, { id: 1, sms_2fa_enabled: 1, sms_2fa_phone_e164: '+27821230001' }, {}, value => value), {
      phone: '+27821230001', source: 'account'
    });
  } finally { db.close(); }
});

test('duplicate profile formats form one candidate and invalid profiles cannot add candidates', () => {
  const db = new Database(':memory:');
  try {
    db.exec('CREATE TABLE vault_entries(user_id INTEGER,section TEXT,fields_encrypted TEXT)');
    const insert = db.prepare('INSERT INTO vault_entries VALUES(?,?,?)');
    for (const fields of [{ mobile_phone: '0821234567' }, { mobile_phone: '+27821234567' }, { mobile_phone: 'bad' }]) {
      insert.run(1, 'personal', JSON.stringify(fields));
    }
    insert.run(1, 'personal', 'malformed JSON');
    assert.deepEqual(resolveSavedPhone(db, { id: 1, sms_2fa_enabled: 0 }, {}, value => value), { phone: '+27821234567', source: 'personal' });
  } finally { db.close(); }
});
