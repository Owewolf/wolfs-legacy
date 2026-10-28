'use strict';
const express=require('express');
const bcrypt=require('bcryptjs');
const rateLimit=require('express-rate-limit');
const {authenticateToken}=require('../middleware/auth');
const {createNotificationService,secretReady}=require('../notifications/service');
const {normalizeAddress}=require('../notifications/parser');
const {createSmtpTransport,createImapReceiver}=require('../notifications/transport');

function createNotificationsRouter({getDb=()=>require('../db').getDb(),env=process.env,now}={}) {
  const router=express.Router();
  router.use(authenticateToken);
  router.use((req,res,next)=>{res.set('Cache-Control','no-store');next();});
  router.use((req,res,next)=>{req.notificationService=createNotificationService({db:getDb(),env,now});next();});
  const limit=rateLimit({windowMs:15*60000,limit:10,keyGenerator:req=>String(req.user.id),standardHeaders:'draft-8',legacyHeaders:false,
    message:{error:'Too many notification changes; try again later'}});
  async function reauthenticate(req,res,next) {
    const password=req.body?.password;
    const user=getDb().prepare('SELECT password_hash FROM users WHERE id=?').get(req.user.id);
    if(typeof password!=='string' || password.length>128 || !user || !await bcrypt.compare(password,user.password_hash))
      return res.status(401).json({error:'Current password required'});
    next();
  }
  function transportReady(reply=false) {
    if(env.NOTIFICATIONS_ENABLED!=='true' || !secretReady(env) || (env.NOTIFICATION_REMINDER_DAYS && env.NOTIFICATION_REMINDER_DAYS!=='5') ||
      (env.NOTIFICATION_TIMEZONE && env.NOTIFICATION_TIMEZONE!=='Africa/Johannesburg')) return false;
    try { const smtp=createSmtpTransport(env);smtp.close();if(reply)createImapReceiver(env);return true;} catch {return false;}
  }
  router.get('/',(req,res)=>{
    const db=getDb(),service=req.notificationService;
    const s=service.settings(req.user.id);
    const d=db.prepare('SELECT notification_cycle_id FROM dead_switch_config WHERE user_id=?').get(req.user.id);
    const cycle=d?.notification_cycle_id?db.prepare('SELECT * FROM notification_cycles WHERE id=? AND user_id=?').get(d.notification_cycle_id,req.user.id):null;
    const {count}=db.prepare('SELECT COUNT(*) count FROM checkin_recovery_codes WHERE user_id=? AND consumed_at IS NULL AND revoked_at IS NULL').get(req.user.id);
    const outbox=db.prepare(`SELECT id,event_type,cycle_id,schedule_at,reminder_number,status,attempts,last_error,sent_at,delivery_confirmed_at
      FROM notification_outbox WHERE user_id=? ORDER BY id DESC LIMIT 50`).all(req.user.id);
    res.json({settings:s?{recipient:s.recipient,verified_at:s.verified_at,reply_enabled:!!s.reply_enabled,timezone:s.timezone,
      reminder_clock:s.reminder_clock,config_status:s.config_status}:null,remaining_codes:count,cycle:cycle||null,outbox,
      health:db.prepare('SELECT * FROM notification_health').all(),transport_configured:transportReady(),reply_transport_configured:transportReady(true)});
  });
  router.post('/verify/start',limit,reauthenticate,(req,res)=>{
    const recipient=normalizeAddress(typeof req.body.recipient==='string'?req.body.recipient.trim():'');
    if(!recipient)return res.status(400).json({error:'Valid notification address required'});
    if(!transportReady())return res.status(503).json({error:'Configure and enable SMTP transport first'});
    res.json(req.notificationService.startVerification(req.user.id,recipient));
  });
  router.post('/verify/complete',limit,(req,res)=>{
    if(typeof req.body.code!=='string' || req.body.code.length>100 || !req.notificationService.completeVerification(req.user.id,req.body.code))
      return res.status(400).json({error:'Verification code could not be accepted'});
    res.json({success:true});
  });
  router.post('/recovery-codes',limit,reauthenticate,(req,res)=>{
    if(!req.notificationService.settings(req.user.id)?.verified_at)return res.status(400).json({error:'Verify the notification address first'});
    res.json(req.notificationService.rotateRecoveryCodes(req.user.id));
  });
  router.put('/settings',limit,reauthenticate,(req,res)=>{
    if(typeof req.body.reply_enabled!=='boolean')return res.status(400).json({error:'reply_enabled must be true or false'});
    if(req.body.reply_enabled && (!transportReady(true) || req.body.offline_stored_separately!==true))
      return res.status(400).json({error:'Ready mail transport and confirmation of separately stored offline codes are required'});
    try {
      res.json(req.notificationService.configureNotifications(req.user.id,{replyEnabled:req.body.reply_enabled,
        timezone:req.body.timezone||'Africa/Johannesburg',reminderClock:req.body.reminder_clock??null}));
    } catch {res.status(400).json({error:'Verified notification address, unused offline codes and valid schedule settings required'});}
  });
  router.post('/test',limit,reauthenticate,(req,res)=>{
    if(!transportReady() || !req.notificationService.settings(req.user.id)?.verified_at)
      return res.status(400).json({error:'Ready transport and verified notification address required'});
    const id=req.notificationService.queue('email_test',req.user.id);
    res.json({status:'queued',id});
  });
  return router;
}
module.exports=createNotificationsRouter();
module.exports.createNotificationsRouter=createNotificationsRouter;
