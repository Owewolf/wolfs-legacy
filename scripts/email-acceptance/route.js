'use strict';
// This module is copied into the disposable server only. It is never mounted by
// production index.js and refuses to load outside the explicitly isolated tree.
const path=require('node:path');
const fs=require('node:fs');
const crypto=require('node:crypto');
if(!process.env.EMAIL_ACCEPTANCE_ROOT || path.resolve(__dirname,'..')!==process.env.EMAIL_ACCEPTANCE_ROOT ||
  !fs.realpathSync(process.env.EMAIL_ACCEPTANCE_ROOT).startsWith(path.join(require('node:os').tmpdir(),'wolfs-legacy-email-acceptance-')) ||
  process.env.LISTEN_HOST!=='127.0.0.1')throw new Error('Acceptance isolation required');
const express=require('express');
const bcrypt=require('bcryptjs');
const rateLimit=require('express-rate-limit');
const {getDb}=require('./db');
const {authenticateToken}=require('./middleware/auth');
const {createNotificationService,audit}=require('./notifications/service');
const {DAY}=require('./notifications/time');
const router=express.Router();
router.use(authenticateToken);
router.use((req,res,next)=>{res.set('Cache-Control','no-store');next();});
getDb().exec(`CREATE TABLE IF NOT EXISTS acceptance_runs(user_id INTEGER PRIMARY KEY,started_at TEXT NOT NULL,
  cycle_id TEXT NOT NULL,initial_last_check_in TEXT NOT NULL,beneficiary_ids TEXT NOT NULL)`);
router.get('/status',(req,res)=>{
  const db=getDb();const run=db.prepare('SELECT * FROM acceptance_runs WHERE user_id=?').get(req.user.id);
  if(!run)return res.json({started:false});
  const user=db.prepare('SELECT last_check_in FROM users WHERE id=?').get(req.user.id);
  const accepted=db.prepare("SELECT COUNT(*) n FROM inbound_message_log WHERE user_id=? AND cycle_id=? AND outcome='accepted'").get(req.user.id,run.cycle_id).n;
  const consumed=db.prepare('SELECT COUNT(*) n FROM checkin_recovery_codes WHERE user_id=? AND consumed_at>=?').get(req.user.id,run.started_at).n;
  const acknowledgement=db.prepare("SELECT status FROM notification_outbox WHERE user_id=? AND event_type='checkin_confirmed' AND created_at>=? ORDER BY id DESC LIMIT 1").get(req.user.id,run.started_at);
  res.json({started:true,initial_cycle_id:run.cycle_id,started_at:run.started_at,last_check_in:user.last_check_in,
    accepted_replies:accepted,consumed_codes:consumed,acknowledgement_status:acknowledgement?.status||null});
});
router.post('/reminder',rateLimit({windowMs:15*60000,limit:5,keyGenerator:req=>String(req.user.id)}),async(req,res)=>{
  const db=getDb();const user=db.prepare('SELECT password_hash FROM users WHERE id=?').get(req.user.id);
  if(typeof req.body.password!=='string'||req.body.password.length>128||!user||!await bcrypt.compare(req.body.password,user.password_hash))
    return res.status(401).json({error:'Current test-owner password required'});
  const service=createNotificationService({db});const settings=service.settings(req.user.id);
  if(!settings?.verified_at||!settings.reply_enabled||settings.config_status!=='ready')
    return res.status(400).json({error:'Verify the address, save offline codes independently, and enable reply check-ins first'});
  try {
    const result=db.transaction(()=>{
      if(db.prepare('SELECT 1 FROM acceptance_runs WHERE user_id=?').get(req.user.id))return null;
      const at=new Date().toISOString();
      // A real 30+7-day cycle: reminder 1 is due five seconds from now. No
      // production scheduler logic is bypassed and no release is forced.
      const initial=new Date(Date.now()-32*DAY+5000).toISOString();
      db.prepare('UPDATE users SET last_check_in=? WHERE id=?').run(initial,req.user.id);
      db.prepare('UPDATE dead_switch_config SET is_active=1,switch_triggered=0,switch_triggered_at=NULL,check_in_interval_days=30,grace_period_days=7 WHERE user_id=?').run(req.user.id);
      const add=db.prepare(`INSERT INTO beneficiaries(user_id,name,access_token,emergency_access_requested,emergency_access_requested_at,
        emergency_waiting_days,access_granted,access_granted_at) VALUES(?,?,?,?,?,90,?,?)`);
      const emergency=add.run(req.user.id,'Synthetic emergency-request beneficiary',crypto.randomBytes(32).toString('hex'),1,at,0,null).lastInsertRowid;
      const granted=add.run(req.user.id,'Synthetic already-granted beneficiary',crypto.randomBytes(32).toString('hex'),0,null,1,at).lastInsertRowid;
      db.prepare('UPDATE notification_settings SET reminder_clock=NULL WHERE user_id=?').run(req.user.id);
      const cycle=service.newCycle(req.user.id,'isolated_provider_acceptance',at);
      db.prepare('INSERT INTO acceptance_runs VALUES(?,?,?,?,?)').run(req.user.id,at,cycle.id,initial,JSON.stringify([Number(emergency),Number(granted)]));
      audit(db,req.user.id,'isolated_email_acceptance_started',`cycle=${cycle.id}`,at);
      return {cycle_id:cycle.id,release_at:cycle.expiry_at};
    }).immediate();
    if(!result)return res.status(409).json({error:'This test owner already has an acceptance reminder; inspect the current run'});
    res.json({status:'queued',...result});
  }catch {res.status(500).json({error:'Disposable acceptance setup failed'});}
});
module.exports=router;
