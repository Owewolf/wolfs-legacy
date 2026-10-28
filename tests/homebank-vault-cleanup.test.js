'use strict';

// This migration test creates its own in-memory database and never loads
// server/db, so it cannot open the application's on-disk vault.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
process.env.ENCRYPTION_KEY = 'cd'.repeat(32);
const { encrypt, decrypt } = require('../server/crypto');
const { clearStoredHomebankLedger } = require('../server/homebank-vault');

test('startup cleanup removes linked copied ledgers without changing identity, details or documents', () => {
  const db = new Database(':memory:');
  try {
    db.exec(`CREATE TABLE vault_entries (
      id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, section TEXT NOT NULL,
      title TEXT NOT NULL, fields_encrypted TEXT NOT NULL, notes_encrypted TEXT,
      homebank_account_id INTEGER, created_at TEXT, updated_at TEXT
    );
    CREATE TABLE document_associations (document_id TEXT, entry_id INTEGER);`);
    const insert = db.prepare(`INSERT INTO vault_entries
      (id,user_id,section,title,fields_encrypted,notes_encrypted,homebank_account_id,created_at,updated_at)
      VALUES (?,42,?,?,?,?,?,'2020-01-01','2020-02-02')`);
    const mappings = [
      ['bank_accounts', 'balance_approx'], ['investments', 'value_approx'],
      ['retirement', 'value_approx'], ['debts', 'outstanding'],
      ['real_estate', 'current_value'], ['vehicles', 'loan_balance'],
    ];
    for (const [index, [section, balanceField]] of mappings.entries()) {
      insert.run(index + 1, section, `Fixture ${section}`,
        encrypt(JSON.stringify({ provider: 'Owner-supplied lender', loan_balance: 'ZAR 500.00',
          current_value: 'ZAR 600.00', [balanceField]: 'ZAR 123.45', homebank_balance: 'ZAR 432.10' })),
        encrypt('Legacy HomeBank notes with copied ledger values'), 100 + index);
      db.prepare('INSERT INTO document_associations VALUES (?,?)').run(`fixture-doc-${index}`, index + 1);
    }
    insert.run(10, 'bank_accounts', 'Manual record',
      encrypt(JSON.stringify({ balance_approx: 'ZAR 987.65' })), encrypt('Manual notes'), null);
    // A linked record can be closed, excluded or absent from the current source:
    // cleanup must not depend on source visibility or an available snapshot.
    insert.run(11, 'vehicles', 'Missing source record',
      encrypt(JSON.stringify({ loan_balance: 'ZAR -20.00', homebank_balance: 'ZAR -20.00', vin: 'Fixture VIN' })),
      encrypt('Old notes'), 999);
    insert.run(12, 'vehicles', 'Corrupt linked record', encrypt('{invalid JSON'), encrypt('Recoverable notes'), 998);
    insert.run(13, 'debts', 'Previously cleaned record', encrypt('{ "creditor": "Owner lender" }'), null, 997);
    insert.run(14, 'debts', 'Notes-only cleanup', encrypt('{ "creditor": "Owner lender" }'), encrypt('Old notes'), 996);

    const before = db.prepare('SELECT * FROM vault_entries ORDER BY id').all();
    const documentsBefore = db.prepare('SELECT * FROM document_associations').all();
    assert.equal(clearStoredHomebankLedger(db), 8);
    const after = db.prepare('SELECT * FROM vault_entries ORDER BY id').all();
    for (const [index, [section, balanceField]] of mappings.entries()) {
      const row = after.find(e => e.id === index + 1);
      assert.equal(row.section, section);
      const expectedFields = {
        provider: 'Owner-supplied lender', loan_balance: 'ZAR 500.00', current_value: 'ZAR 600.00',
      };
      delete expectedFields[balanceField];
      assert.deepEqual(JSON.parse(decrypt(row.fields_encrypted)), expectedFields);
      assert.equal(JSON.parse(decrypt(row.fields_encrypted))[balanceField], undefined);
      assert.equal(JSON.parse(decrypt(row.fields_encrypted)).homebank_balance, undefined);
      assert.equal(row.notes_encrypted, null);
      for (const key of ['id', 'user_id', 'section', 'title', 'homebank_account_id', 'created_at', 'updated_at']) {
        assert.equal(row[key], before.find(e => e.id === row.id)[key], key);
      }
    }
    assert.deepEqual(JSON.parse(decrypt(after.find(e => e.id === 11).fields_encrypted)), { vin: 'Fixture VIN' });
    for (const id of [10, 12, 13]) {
      assert.deepEqual(after.find(e => e.id === id), before.find(e => e.id === id));
    }
    const notesOnly = after.find(e => e.id === 14);
    assert.equal(notesOnly.fields_encrypted, before.find(e => e.id === 14).fields_encrypted,
      'Clearing notes must preserve ciphertext for unchanged fields');
    assert.equal(notesOnly.notes_encrypted, null);
    assert.deepEqual(db.prepare('SELECT * FROM document_associations').all(), documentsBefore);
    assert.equal(clearStoredHomebankLedger(db), 0);
    assert.deepEqual(db.prepare('SELECT * FROM vault_entries ORDER BY id').all(), after,
      'Repeated startup must not rewrite ciphertext or timestamps');
  } finally {
    db.close();
  }
});
