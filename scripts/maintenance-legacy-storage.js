#!/usr/bin/env node
'use strict';

// Explicit paths only. Never loads the running app, its environment or secrets.
// Reports old temporary/untracked generated copies by default. Purging requires
// both flags and an operator-stopped writer; originals and tracked copies stay.
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const GENERATED = /^owner-[1-9][0-9]*\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.(pdf|png|jpg|jpeg|webp|doc|docx|xls|xlsx|txt|mp3|m4a|wav|mp4|mov)$/;
const TEMPORARY = /^upload-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const MIN_AGE_MS = 24 * 60 * 60 * 1000;
function privateDirectory(directory) {
  let ancestor = directory;
  while (true) {
    if (fs.lstatSync(ancestor).isSymbolicLink()) throw new Error('Symlink in storage path');
    const parent = path.dirname(ancestor); if (parent === ancestor) break; ancestor = parent;
  }
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) throw new Error('Storage must be a private service-owned directory');
}
function absolute(input) {
  if (typeof input !== 'string' || !path.isAbsolute(input) || /[\r\n\0]/.test(input)) throw new Error('Absolute paths required');
  return path.resolve(input);
}
function maintenance({ databasePath, storageRoot, purge = false, serviceStopped = false, now = Date.now() }) {
  if (purge && !serviceStopped) throw new Error('Stop all application writers and supply --service-stopped before purging');
  const root = absolute(storageRoot), database = absolute(databasePath); privateDirectory(root);
  // Reject mounts at or within the root, matching the managed-store boundary.
  if (fs.existsSync('/proc/self/mountinfo')) for (const line of fs.readFileSync('/proc/self/mountinfo', 'utf8').split('\n')) {
    const mount = line.split(' ')[4]?.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
    if (mount && (mount === root || mount.startsWith(root + path.sep))) throw new Error('Mounted child storage refused');
  }
  let ancestor = database;
  while (true) {
    if (fs.lstatSync(ancestor).isSymbolicLink()) throw new Error('Symlink in database path');
    const parent = path.dirname(ancestor); if (parent === ancestor) break; ancestor = parent;
  }
  if (!fs.lstatSync(database).isFile()) throw new Error('Expected an existing database');
  const db = new Database(database, { readonly: true, fileMustExist: true });
  try {
    const integrity = db.pragma('integrity_check');
    if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok' || db.pragma('foreign_key_check').length) throw new Error('Database integrity failure');
    const tracked = new Set(db.prepare('SELECT stored_filename FROM managed_documents').all().map(row => row.stored_filename));
    const candidates = []; let preservedRecent = 0;
    for (const directory of fs.readdirSync(root).sort()) {
      if (directory !== '.incoming' && !/^owner-[1-9][0-9]*$/.test(directory)) continue;
      const folder = path.join(root, directory); privateDirectory(folder);
      for (const filename of fs.readdirSync(folder).sort()) {
        const relative = directory + '/' + filename;
        if (directory === '.incoming' ? !TEMPORARY.test(filename) : !GENERATED.test(relative) || tracked.has(relative)) continue;
        const target = path.join(folder, filename), stat = fs.lstatSync(target);
        if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) throw new Error('Unsafe candidate file');
        if (now - Math.max(stat.mtimeMs, stat.ctimeMs) < MIN_AGE_MS) { preservedRecent++; continue; }
        candidates.push({ path: relative, bytes: stat.size, kind: directory === '.incoming' ? 'abandoned_upload' : 'untracked_copy', dev: stat.dev, ino: stat.ino, mtime: stat.mtimeMs, size: stat.size });
      }
    }
    if (purge) for (const candidate of candidates) {
      const target = path.join(root, candidate.path), stat = fs.lstatSync(target);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.dev !== candidate.dev || stat.ino !== candidate.ino || stat.mtimeMs !== candidate.mtime || stat.size !== candidate.size) throw new Error('Candidate changed during inspection');
      if (candidate.kind === 'untracked_copy' && db.prepare('SELECT 1 FROM managed_documents WHERE stored_filename=?').get(candidate.path)) throw new Error('Candidate became tracked');
      fs.unlinkSync(target);
    }
    return { mode: purge ? 'purged' : 'report_only', minimumAgeHours: 24, preservedRecent,
      candidates: candidates.map(({ path: relative, bytes, kind }) => ({ path: relative, bytes, kind })) };
  } finally { db.close(); }
}
function main(args) {
  try {
    const options = {}, names = { '--database': 'databasePath', '--storage-root': 'storageRoot', '--purge': 'purge', '--service-stopped': 'serviceStopped' };
    for (let index = 0; index < args.length; index++) {
      const name = names[args[index]]; if (!name || options[name] !== undefined) throw new Error('Invalid option');
      options[name] = ['purge', 'serviceStopped'].includes(name) ? true : args[++index];
    }
    const result = maintenance(options); process.stdout.write(JSON.stringify(result, null, 2) + '\n'); return 0;
  } catch {
    process.stderr.write('Storage maintenance refused. Use explicit existing private paths; stop all writers before --purge --service-stopped. Originals and tracked files are retained.\nUsage: maintenance-legacy-storage.js --database /app/data/vault.db --storage-root /managed/root [--purge --service-stopped]\n');
    return 1;
  }
}
if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { maintenance, MIN_AGE_MS };
