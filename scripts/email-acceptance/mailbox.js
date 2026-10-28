'use strict';
const crypto=require('node:crypto');

async function seedMailbox(db,env,{createClient}={}) {
  // A fresh disposable DB must have no enrolled factors or test users yet.
  if(db.prepare('SELECT COUNT(*) n FROM users').get().n!==0)throw new Error('Fresh acceptance database required');
  const port=Number(env.CHECKIN_IMAP_PORT||993);
  const account=crypto.createHash('sha256').update(JSON.stringify([env.CHECKIN_IMAP_HOST,port,env.CHECKIN_IMAP_USERNAME])).digest('hex');
  const mailbox=env.CHECKIN_IMAP_MAILBOX||'INBOX';
  const factory=createClient||(options=>new(require('imapflow').ImapFlow)(options));
  const client=factory({host:env.CHECKIN_IMAP_HOST,port,secure:true,
    auth:{user:env.CHECKIN_IMAP_USERNAME,pass:env.CHECKIN_IMAP_PASSWORD},
    tls:{minVersion:'TLSv1.2',rejectUnauthorized:true,servername:env.CHECKIN_IMAP_HOST},
    logger:false,logRaw:false,emitLogs:false,disableAutoIdle:true,disableCompression:true,
    connectionTimeout:15000,greetingTimeout:10000,socketTimeout:30000});
  let lock;
  try {
    client.on?.('error',()=>{});
    await client.connect();
    lock=await client.getMailboxLock(mailbox,{readOnly:true});
    const uidValidity=String(client.mailbox.uidValidity),lastUid=Number(client.mailbox.uidNext)-1;
    if(!/^\d+$/.test(uidValidity)||!Number.isSafeInteger(lastUid)||lastUid<0)throw new Error('Invalid mailbox UID state');
    db.prepare(`INSERT INTO inbound_checkpoints(account,mailbox,uid_validity,last_uid) VALUES(?,?,?,?)`).run(account,mailbox,uidValidity,lastUid);
    return {account,mailbox,uid_validity:uidValidity,last_uid:lastUid,seeded_at:new Date().toISOString()};
  }catch {throw new Error('Acceptance mailbox preflight failed');}
  finally {
    try{lock?.release();}catch{}
    try{await client.logout();}catch{try{client.close();}catch{}}
  }
}
module.exports={seedMailbox};
