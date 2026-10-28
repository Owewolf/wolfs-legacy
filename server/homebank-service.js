'use strict';
// Read-only HomeBank integration: never opens source XHB for writing.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { getDb, audit } = require('./db');
const { encrypt, decrypt } = require('./crypto');
const MAX_BYTES = 50 * 1024 * 1024;
// Keep in step with homebank_parse.py; reparse old snapshots on parser upgrades.
const SNAPSHOT_SCHEMA_VERSION = 2;
const ROOT = path.resolve(process.env.HOMEBANK_ALLOWED_ROOT || '/home/wolf/Documents');
const DEFAULT_DIRECTORY = process.env.HOMEBANK_DIRECTORY || '/home/wolf/Documents/Money';
const inflight = new Map();
const NOW = () => new Date().toISOString();
const localDay = () => { const d = new Date(); return [d.getFullYear(), String(d.getMonth()+1).padStart(2,'0'), String(d.getDate()).padStart(2,'0')].join('-'); };

function initialConfig() { return { directory: DEFAULT_DIRECTORY, selectedFile: '', auto: true }; }
function row(userId) {
  return getDb().prepare('SELECT * FROM homebank_snapshots WHERE user_id=?').get(userId);
}
function decodedConfig(r) {
  if (!r || !r.config_encrypted) return initialConfig();
  try { return JSON.parse(decrypt(r.config_encrypted)); } catch { return initialConfig(); }
}
function decodedSnapshot(r) {
  if (!r || !r.snapshot_encrypted) return null;
  try { return JSON.parse(decrypt(r.snapshot_encrypted)); } catch { return null; }
}
function ownedRow(userId) {
  const db = getDb();
  db.prepare('INSERT OR IGNORE INTO homebank_snapshots (user_id, config_encrypted) VALUES (?, ?)')
    .run(userId, encrypt(JSON.stringify(initialConfig())));
  return row(userId);
}
function isWithin(child, parent) {
  const rel = path.relative(parent, child);
  return !rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel);
}
async function secureDirectory(candidate) {
  if (typeof candidate !== 'string' || !path.isAbsolute(candidate) || candidate.length > 2048) {
    throw new Error('Choose an absolute directory path inside the allowed documents root');
  }
  const [allowed, resolved] = await Promise.all([fs.realpath(ROOT), fs.realpath(candidate)]);
  if (!isWithin(resolved, allowed)) throw new Error('Folder must be inside ' + ROOT);
  if (!(await fs.stat(resolved)).isDirectory()) throw new Error('Not a directory');
  return resolved;
}
function safeFilename(name) {
  if (typeof name !== 'string' || name.includes('/') || name.includes('\\') || name.startsWith('.') ||
      !name.toLowerCase().endsWith('.xhb') || name.length > 250 || name.includes('\0')) {
    throw new Error('Select a valid .xhb filename');
  }
  return name;
}
async function listing(directory) {
  const canonical = await secureDirectory(directory);
  const candidates = [];
  for (const dirent of await fs.readdir(canonical, { withFileTypes: true })) {
    if (!dirent.isFile() || !/^[^.].*\.xhb$/i.test(dirent.name)) continue;
    const full = path.join(canonical, dirent.name);
    const st = await fs.stat(full);
    if (st.size > MAX_BYTES) continue;
    candidates.push({ name: dirent.name, mtime: st.mtime.toISOString(), size: st.size,
      full, fingerprint: `${dirent.name}:${st.size}:${st.mtimeMs}` });
  }
  candidates.sort((a, b) => b.mtime.localeCompare(a.mtime) || a.name.localeCompare(b.name));
  return candidates;
}
async function directories(directory) {
  const canonical = await secureDirectory(directory);
  const dirs = [];
  for (const d of await fs.readdir(canonical, { withFileTypes: true })) {
    if (!d.isDirectory() || d.name.startsWith('.')) continue;
    const full = path.join(canonical, d.name);
    try { await secureDirectory(full); dirs.push({ name: d.name, path: full }); } catch { /* no out-of-root folders */ }
  }
  return { current: canonical, parent: canonical === (await fs.realpath(ROOT)) ? null : path.dirname(canonical), folders: dirs.sort((a,b)=>a.name.localeCompare(b.name)) };
}
function parseXhb(filepath) {
  return new Promise((resolve, reject) => {
    const bin = process.env.HOMEBANK_PYTHON || 'python3';
    const child = spawn(bin, [path.join(__dirname, 'homebank_parse.py'), filepath], { stdio: ['ignore','pipe','pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('HomeBank parser timed out')); }, 30000);
    child.stdout.on('data', c => {
      stdout += c.toString();
      if (stdout.length > 20 * 1024 * 1024) child.kill('SIGKILL');
    });
    child.stderr.on('data', c => { if (stderr.length < 2000) stderr += c.toString(); });
    child.on('error', e => { clearTimeout(timer); reject(new Error('Parser unavailable: ' + e.message)); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error('HomeBank file could not be validated' + (stderr ? ': ' + stderr.trim().slice(0,150) : '')));
      try { resolve(JSON.parse(stdout)); } catch { reject(new Error('Invalid parser output')); }
    });
  });
}
async function syncUser(userId, force = false) {
  if (inflight.has(userId)) return inflight.get(userId);
  const task = (async () => {
    let current = ownedRow(userId);
    const cfg = decodedConfig(current);
    if (!cfg.auto && !force) return current;
    try {
      const files = await listing(cfg.directory);
      const file = cfg.selectedFile ? files.find(f => f.name === cfg.selectedFile) : files[0];
      if (!file) throw new Error('No HomeBank .xhb file found in the selected directory');
      const existing = decodedSnapshot(current);
      if (!force && current.fingerprint === file.fingerprint && current.snapshot_encrypted && !current.last_error &&
          existing?.snapshot_schema_version === SNAPSHOT_SCHEMA_VERSION && existing?.exported_date === localDay()) return current;
      // Validate file again after parsing, so incomplete atomic saves never replace a good snapshot.
      const snap = await parseXhb(file.full);
      const after = await fs.stat(file.full);
      if (after.size !== file.size || Math.abs(after.mtimeMs - Date.parse(file.mtime)) > 2) {
        throw new Error('File changed during reading; keeping previous validated snapshot');
      }
      const hash = crypto.createHash('sha256').update(JSON.stringify(snap)).digest('hex');
      const syncedAt = NOW();
      getDb().prepare(`UPDATE homebank_snapshots SET snapshot_encrypted=?,fingerprint=?,source_file=?,
        source_saved_at=?,synced_at=?,last_error=NULL,content_hash=? WHERE user_id=?`)
        .run(encrypt(JSON.stringify(snap)), file.fingerprint, file.name, file.mtime, syncedAt, hash, userId);
      audit(userId, 'homebank_sync_success', 'homebank', null, `accounts=${snap.counts.all}`, null);
    } catch (e) {
      const msg = String(e.message).slice(0,300);
      if (current.last_error !== msg) getDb().prepare('UPDATE homebank_snapshots SET last_error=? WHERE user_id=?').run(msg,userId);
    }
    return row(userId);
  })();
  inflight.set(userId, task);
  try { return await task; } finally { inflight.delete(userId); }
}
async function saveSettings(userId, newSettings) {
  const current = ownedRow(userId);
  const config = decodedConfig(current);
  const dir = await secureDirectory(newSettings.directory || config.directory);
  const fileName = newSettings.selectedFile === undefined ? config.selectedFile : newSettings.selectedFile;
  if (fileName) {
    safeFilename(fileName);
    const files = await listing(dir);
    if (!files.some(f=>f.name===fileName)) throw new Error('Selected .xhb file not found in folder');
  }
  const next = { directory: dir, selectedFile: fileName || '', auto: true };
  getDb().prepare('UPDATE homebank_snapshots SET config_encrypted=?,fingerprint=NULL,last_error=NULL WHERE user_id=?')
    .run(encrypt(JSON.stringify(next)),userId);
  audit(userId,'homebank_settings_updated','homebank',null,null,null);
  return syncUser(userId,true);
}
function responseView(r) {
  return { config: decodedConfig(r), source_file: r.source_file || null,
    source_saved_at: r.source_saved_at || null, synced_at:r.synced_at || null,
    last_error:r.last_error || null, stale:!!r.last_error, snapshot: decodedSnapshot(r) };
}
async function refreshAll() {
  const ids = getDb().prepare('SELECT user_id FROM homebank_snapshots').all();
  for (const entry of ids) await syncUser(entry.user_id);
}
function startWatcher() {
  const timer = setInterval(() => refreshAll().catch(e=>console.error('HomeBank refresh failed:',e.message)), 20000);
  timer.unref();
}
module.exports = { ROOT, DEFAULT_DIRECTORY, listing, directories, syncUser, saveSettings, responseView, startWatcher };
