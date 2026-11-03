const express = require('express');
const { getDb, audit } = require('../db');
const { generateAccessToken, hashToken, decrypt } = require('../crypto');
const { authenticateToken } = require('../middleware/auth');
const { listForEntry } = require('../document-store');
const { validateString, validateEmail, validateInt, validationError } = require('../validate');
const { getVaultVisibility } = require('../vault-visibility');
const { projectHomebankEntry } = require('../homebank-vault');
const homebank = require('../homebank-service');
const { recordBeneficiaryEvent } = require('../notifications/service');
const { utc } = require('../notifications/time');
const legacy = require('../legacy-content');
const { ensureBeneficiaryFinalWish } = require('../beneficiary-final-wishes');
const autoWish = require('../beneficiary-auto-wish');

const router = express.Router();
router.use((req,res,next)=>{res.set('Cache-Control','private, no-store');next();});

const TOKEN_LIFETIME_DAYS = 730; // 2 years

function tokenExpiresAt() {
  return new Date(Date.now() + TOKEN_LIFETIME_DAYS * 86400000).toISOString();
}

function isTokenExpired(b) {
  if(!b.token_expires_at)return false;
  try{return utc(b.token_expires_at).getTime()<=Date.now();}catch{return true;}
}

// ── Owner endpoints ──

router.get('/', authenticateToken, (req, res) => {
  const db = getDb();
  res.json(db.prepare(
    `SELECT id, name, email, phone, relationship, emergency_access_requested,
     emergency_access_requested_at, emergency_waiting_days, access_granted,
     access_granted_at, auto_wish_access_revoked_at, token_expires_at, created_at
     FROM beneficiaries WHERE user_id = ?`
  ).all(req.user.id));
});

router.post('/', authenticateToken, (req, res) => {
  const { name, email, phone, relationship, emergency_waiting_days } = req.body;
  if (!validateString(name, 1, 200)) return validationError(res, 'Name is required (max 200 chars)');
  if (email && !validateEmail(email)) return validationError(res, 'Invalid email format');
  const waitDays = parseInt(emergency_waiting_days) || 7;
  if (waitDays < 1 || waitDays > 90) return validationError(res, 'Wait period must be 1-90 days');

  const db = getDb();
  const token = generateAccessToken();
  const expires = tokenExpiresAt();
  const created = db.transaction(() => {
    const result = db.prepare(
      'INSERT INTO beneficiaries (user_id, name, email, phone, relationship, access_token, token_expires_at, emergency_waiting_days) VALUES (?,?,?,?,?,?,?,?)'
    ).run(req.user.id, name.trim(), email || null, phone || null, relationship || null, hashToken(token), expires, waitDays);
    const beneficiaryId = Number(result.lastInsertRowid);
    const wish = ensureBeneficiaryFinalWish(db, req.user.id, beneficiaryId);
    // This creation audit must be durable alongside both records; the general
    // audit helper is intentionally best effort and cannot protect this write.
    db.prepare('INSERT INTO audit_log (user_id, action, target_type, target_id, detail, ip_address) VALUES (?,?,?,?,?,?)')
      .run(req.user.id, 'add_beneficiary', 'beneficiary', beneficiaryId, name.trim(), req.ip || null);
    return { beneficiaryId, wishId: wish.id };
  })();
  res.json({ id: created.beneficiaryId, name: name.trim(), email, phone, relationship, accessToken: token, token_expires_at: expires, emergency_waiting_days: waitDays,
    final_wish_id: created.wishId, final_wish: { id: created.wishId } });
});

router.put('/:id', authenticateToken, (req, res) => {
  const { name, email, phone, relationship, emergency_waiting_days } = req.body;
  if (!validateString(name, 1, 200)) return validationError(res, 'Name is required (max 200 chars)');
  if (email && !validateEmail(email)) return validationError(res, 'Invalid email format');
  const waitDays = parseInt(emergency_waiting_days) || 7;
  if (waitDays < 1 || waitDays > 90) return validationError(res, 'Wait period must be 1-90 days');

  const db = getDb();
  const result = db.prepare(
    `UPDATE beneficiaries
     SET name = ?, email = ?, phone = ?, relationship = ?, emergency_waiting_days = ?
     WHERE id = ? AND user_id = ?`
  ).run(name.trim(), email || null, phone || null, relationship || null, waitDays, req.params.id, req.user.id);

  if (result.changes === 0) return res.status(404).json({ error: 'Not found' });
  audit(req.user.id, 'edit_beneficiary', 'beneficiary', +req.params.id, name.trim(), req.ip);

  const updated = db.prepare(
    `SELECT id, name, email, phone, relationship, emergency_access_requested,
     emergency_access_requested_at, emergency_waiting_days, access_granted,
     access_granted_at, auto_wish_access_revoked_at, token_expires_at, created_at
     FROM beneficiaries WHERE id = ? AND user_id = ?`
  ).get(req.params.id, req.user.id);
  res.json(updated);
});

router.delete('/:id', authenticateToken, (req, res) => {
  const db = getDb();
  const removed = db.transaction(() => {
    const automatic=db.prepare(`SELECT a.content_id FROM legacy_beneficiary_auto_wishes a
      JOIN beneficiaries b ON b.id=a.beneficiary_id WHERE a.beneficiary_id=? AND a.owner_user_id=? AND b.user_id=?`)
      .get(req.params.id,req.user.id,req.user.id);
    if(automatic) {
      db.prepare("UPDATE legacy_contents SET status='archived',updated_at=? WHERE id=? AND user_id=?")
        .run(legacy.now(),automatic.content_id,req.user.id);
      legacy.event(db,{userId:req.user.id,contentId:automatic.content_id,beneficiaryId:Number(req.params.id),type:'auto_wish_beneficiary_removed'});
    }
    const r = db.prepare('DELETE FROM beneficiaries WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
    if (r.changes === 0) return false;
    // Outbox beneficiary IDs intentionally survive deletion for delivery
    // history. Cancel work that has not started so it cannot later announce
    // access changes for a beneficiary the owner has removed.
    db.prepare(`UPDATE notification_outbox SET status='cancelled', next_attempt_at=NULL, updated_at=?
      WHERE user_id=? AND beneficiary_id=? AND status IN ('queued','retried','failed')`)
      .run(new Date().toISOString(), req.user.id, req.params.id);
    return true;
  })();
  if (!removed) return res.status(404).json({ error: 'Not found' });
  audit(req.user.id, 'remove_beneficiary', 'beneficiary', +req.params.id, null, req.ip);
  res.json({ success: true });
});

router.post('/:id/deny-emergency', authenticateToken, (req, res) => {
  const db = getDb();
  const found = db.transaction(() => {
    const b = db.prepare('SELECT * FROM beneficiaries WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
    if (!b) return false;
    if (!b.emergency_access_requested) return true;
    db.prepare('UPDATE beneficiaries SET emergency_access_requested = 0, emergency_access_requested_at = NULL WHERE id = ?').run(b.id);
    recordBeneficiaryEvent(db, { type: 'emergency_denied', userId: b.user_id,
      beneficiary: { ...b, emergency_access_requested: 0, emergency_access_requested_at: null }, ip: req.ip });
    audit(req.user.id, 'deny_emergency', 'beneficiary', b.id, null, req.ip);
    return true;
  })();
  if (!found) return res.status(404).json({ error: 'Not found' });
  res.json({ success: true });
});

router.post('/:id/grant', authenticateToken, (req, res) => {
  const db = getDb();
  const found = db.transaction(() => {
    const b = db.prepare('SELECT * FROM beneficiaries WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
    if (!b) return false;
    if (b.access_granted) return true;
    const now = new Date().toISOString();
    db.prepare('UPDATE beneficiaries SET access_granted = 1, access_granted_at = ? WHERE id = ?').run(now, b.id);
    recordBeneficiaryEvent(db, { type: 'access_granted', userId: b.user_id,
      beneficiary: { ...b, access_granted: 1, access_granted_at: now }, now, ip: req.ip });
    if(b.emergency_access_requested) legacy.releaseForEvent(db,{userId:b.user_id,beneficiaryId:b.id,policy:'emergency_access_release',eventKey:`manual-emergency:${b.id}:${now}`,at:now});
    audit(req.user.id, 'grant_access', 'beneficiary', b.id, null, req.ip);
    return true;
  })();
  if (!found) return res.status(404).json({ error: 'Not found' });
  res.json({ success: true });
});

router.post('/:id/revoke', authenticateToken, (req, res) => {
  const db = getDb();
  const found = db.transaction(() => {
    const b = db.prepare('SELECT * FROM beneficiaries WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
    if (!b) return false;
    db.prepare('UPDATE beneficiaries SET auto_wish_access_revoked_at=COALESCE(auto_wish_access_revoked_at,?) WHERE id=? AND user_id=?')
      .run(legacy.now(),b.id,req.user.id);
    legacy.revokeForBeneficiary(db,{userId:b.user_id,beneficiaryId:b.id});
    if (!b.access_granted && !b.emergency_access_requested) return true;
    db.prepare('UPDATE beneficiaries SET access_granted = 0, access_granted_at = NULL, emergency_access_requested = 0, emergency_access_requested_at = NULL WHERE id = ?').run(b.id);
    recordBeneficiaryEvent(db, { type: b.access_granted ? 'access_revoked' : 'emergency_denied', userId: b.user_id,
      beneficiary: { ...b, access_granted: 0, access_granted_at: null,
        emergency_access_requested: 0, emergency_access_requested_at: null }, ip: req.ip });
    audit(req.user.id, 'revoke_access', 'beneficiary', b.id, null, req.ip);
    return true;
  })();
  if (!found) return res.status(404).json({ error: 'Not found' });
  res.json({ success: true });
});

router.post('/:id/restore-personal-wish-access', authenticateToken, (req,res) => {
  if(req.body?.confirmed!==true)return validationError(res,'Explicit confirmation is required');
  const db=getDb();
  const restored=db.transaction(()=>{
    const b=db.prepare('SELECT * FROM beneficiaries WHERE id=? AND user_id=?').get(req.params.id,req.user.id);
    if(!b)return false;
    const marker=autoWish.forBeneficiary(db,b.id);
    if(!marker||marker.owner_user_id!==req.user.id||!autoWish.validBinding(db,marker))return false;
    db.prepare('UPDATE beneficiaries SET auto_wish_access_revoked_at=NULL WHERE id=? AND user_id=?').run(b.id,req.user.id);
    db.prepare('UPDATE legacy_content_beneficiaries SET revoked_at=NULL WHERE content_id=? AND beneficiary_id=?').run(marker.content_id,b.id);
    legacy.event(db,{userId:req.user.id,contentId:marker.content_id,beneficiaryId:b.id,type:'personal_wish_access_restored'});
    return true;
  }).immediate();
  if(!restored)return res.status(404).json({error:'Personal Final Wish not found'});
  res.json({success:true});
});

router.post('/:id/regenerate-token', authenticateToken, (req, res) => {
  const db = getDb();
  const token = generateAccessToken();
  const expires = tokenExpiresAt();
  const r = db.prepare('UPDATE beneficiaries SET access_token = ?, token_expires_at = ? WHERE id = ? AND user_id = ?').run(hashToken(token), expires, req.params.id, req.user.id);
  if (r.changes === 0) return res.status(404).json({ error: 'Not found' });
  audit(req.user.id, 'regenerate_token', 'beneficiary', +req.params.id, null, req.ip);
  res.json({ accessToken: token, token_expires_at: expires });
});

router.get('/:id/legacy', authenticateToken, (req,res,next) => {
  try {
    const db=getDb();
    if(!db.prepare('SELECT 1 FROM beneficiaries WHERE id=? AND user_id=?').get(req.params.id,req.user.id)) return res.status(404).json({error:'Not found'});
    legacy.event(db,{userId:req.user.id,beneficiaryId:Number(req.params.id),type:'owner_recipient_list'});
    res.json(legacy.list(db,req.user.id,{beneficiary_id:req.params.id}).map(item=>{
      const mapping=item.beneficiaries.find(b=>b.beneficiary_id===Number(req.params.id));
      return {...item,released_at:mapping?.released_at,revoked_at:mapping?.revoked_at,release_scope:mapping?.release_scope};
    }));
  } catch(e) {next(e);}
});

// ── Beneficiary endpoints (no auth, uses access token) ──

function lookupBeneficiary(accessToken) {
  if(typeof accessToken!=='string'||!accessToken.length||accessToken.length>256)return {error:'Invalid access token'};
  const db = getDb();
  const b = db.prepare('SELECT * FROM beneficiaries WHERE access_token = ?').get(hashToken(accessToken));
  if (!b) return { error: 'Invalid access token' };
  if (isTokenExpired(b)) return { error: 'Access token has expired. Contact the vault owner for a new one.' };
  return { beneficiary: b };
}

router.post('/emergency-access', (req, res) => {
  const { accessToken } = req.body;
  if (!accessToken) return validationError(res, 'Access token required');

  const { beneficiary: b, error } = lookupBeneficiary(accessToken);
  if (error) return res.status(404).json({ error });
  const db = getDb();
  const result = db.transaction(() => {
    const fresh = db.prepare('SELECT * FROM beneficiaries WHERE id = ?').get(b.id);
    if (!fresh) return null;
    if (fresh.access_granted) return { status: 'already_granted' };
    if (fresh.emergency_access_requested) return { status: 'already_requested', requested_at: fresh.emergency_access_requested_at };
    const now = new Date().toISOString();
    db.prepare('UPDATE beneficiaries SET emergency_access_requested = 1, emergency_access_requested_at = ? WHERE id = ?').run(now, fresh.id);
    recordBeneficiaryEvent(db, { type: 'emergency_requested', userId: fresh.user_id,
      beneficiary: { ...fresh, emergency_access_requested: 1, emergency_access_requested_at: now }, now, ip: req.ip });
    audit(null, 'emergency_request', 'beneficiary', fresh.id, fresh.name, req.ip);
    return { status: 'requested', waiting_days: fresh.emergency_waiting_days };
  })();
  if (!result) return res.status(404).json({ error: 'Not found' });
  res.json(result);
});

router.post('/access', async (req, res) => {
  const { accessToken } = req.body;
  if (!accessToken) return validationError(res, 'Access token required');

  const { beneficiary: b, error } = lookupBeneficiary(accessToken);
  if (error) return res.status(404).json({ error });

  const db = getDb();

  // Use a transaction to prevent race conditions on auto-grant
  const tryAutoGrant = db.transaction(() => {
    // Re-read inside transaction for consistency
    const fresh = db.prepare('SELECT * FROM beneficiaries WHERE id = ?').get(b.id);
    if (!fresh) return false;
    if (fresh.access_granted) return true;

    // Auto-grant if emergency waiting period elapsed
    if (fresh.emergency_access_requested) {
      const waitUntil = new Date(utc(fresh.emergency_access_requested_at).getTime() + fresh.emergency_waiting_days * 86400000);
      if (new Date() >= waitUntil) {
        const now = new Date().toISOString();
        db.prepare('UPDATE beneficiaries SET access_granted = 1, access_granted_at = ? WHERE id = ? AND access_granted = 0').run(now, fresh.id);
        recordBeneficiaryEvent(db, { type: 'emergency_granted', userId: fresh.user_id,
          beneficiary: { ...fresh, access_granted: 1, access_granted_at: now }, now, ip: req.ip });
        legacy.releaseForEvent(db,{userId:fresh.user_id,beneficiaryId:fresh.id,policy:'emergency_access_release',eventKey:`emergency:${fresh.id}:${now}`,at:now});
        audit(null, 'emergency_auto_grant', 'beneficiary', fresh.id, fresh.name, req.ip);
        return true;
      }
    }

    // Auto-grant if dead man's switch triggered
    const sw = db.prepare('SELECT switch_triggered FROM dead_switch_config WHERE user_id = ?').get(fresh.user_id);
    if (sw && sw.switch_triggered) {
      const now = new Date().toISOString();
      db.prepare('UPDATE beneficiaries SET access_granted = 1, access_granted_at = ? WHERE id = ? AND access_granted = 0').run(now, fresh.id);
      recordBeneficiaryEvent(db, { type: 'deadswitch_granted', userId: fresh.user_id,
        beneficiary: { ...fresh, access_granted: 1, access_granted_at: now }, now, ip: req.ip });
      audit(null, 'deadswitch_auto_grant', 'beneficiary', fresh.id, fresh.name, req.ip);
      return true;
    }

    return false;
  });

  const granted = tryAutoGrant();
  const personalMarker=autoWish.forBeneficiary(db,b.id);
  const personalRow=personalMarker?db.prepare('SELECT * FROM legacy_contents WHERE id=?').get(personalMarker.content_id):null;
  const personalAvailable=!!(personalRow&&legacy.canRead(db,b,personalRow));

  if (!granted) {
    let waitInfo = null;
    if (b.emergency_access_requested) {
      const waitUntil = new Date(utc(b.emergency_access_requested_at).getTime() + b.emergency_waiting_days * 86400000);
      waitInfo = { requested_at: b.emergency_access_requested_at, access_at: waitUntil.toISOString() };
    }
    return res.json({ status: b.emergency_access_requested ? 'waiting' : 'no_access', beneficiary: { name: b.name }, waitInfo,
      personal_final_wish_available:personalAvailable });
  }

  // Access granted — return full vault
  const owner = db.prepare('SELECT name, email FROM users WHERE id = ?').get(b.user_id);
  if (owner?.email.trim().toLowerCase() === (process.env.HOMEBANK_OWNER_EMAIL || '').trim().toLowerCase()) {
    try { await homebank.syncUser(b.user_id); } catch { /* use last valid snapshot */ }
  }
  const visibility = getVaultVisibility(b.user_id);
  const rows = db.prepare('SELECT * FROM vault_entries WHERE user_id = ? ORDER BY section, updated_at DESC').all(b.user_id);
  const entries = visibility.filter(rows).map(e => {
    let fields;
    try { fields = JSON.parse(decrypt(e.fields_encrypted)); } catch { fields = { _error: 'Decryption failed' }; }
    return projectHomebankEntry({
      id: e.id, user_id: e.user_id, homebank_account_id: e.homebank_account_id,
      section: e.section, title: e.title, fields,
      notes: e.notes_encrypted ? decrypt(e.notes_encrypted) : '',
      created_at: e.created_at, updated_at: e.updated_at
    }, visibility);
  });

  audit(null, 'vault_accessed', 'beneficiary', b.id, `${b.name} viewed vault of user ${b.user_id}`, req.ip);
  for (const entry of entries) entry.documents = listForEntry(db, b.user_id, entry.id);
  res.json({ status: 'granted', owner, beneficiary: { name: b.name, relationship: b.relationship }, entries,
    personal_final_wish_available:personalAvailable });
});

module.exports = router;
