'use strict';
// This file executes only after being copied into the private staging root.
const path=require('node:path');
const fs=require('node:fs');
if(__dirname!==process.env.EMAIL_ACCEPTANCE_ROOT || process.env.LISTEN_HOST!=='127.0.0.1')throw new Error('Acceptance isolation required');
(async()=>{
  require('./server/config').ensureSecrets();
  const db=require('./server/db').getDb();
  if(process.env.NOTIFICATIONS_ENABLED==='true') {
    require('./server/notifications/transport').createImapReceiver(process.env);
    const checkpoint=await require('./acceptance-mailbox').seedMailbox(db,process.env);
    fs.writeFileSync(path.join(__dirname,'mailbox-checkpoint.json'),JSON.stringify(checkpoint)+'\n',{mode:0o600});
  }
  require('./server/index');
  const remaining=new Date(process.env.EMAIL_ACCEPTANCE_EXPIRES_AT)-Date.now();
  if(!Number.isFinite(remaining)||remaining<=0)throw new Error('Acceptance lifetime expired');
  // Enforce the cap in the child too if its launcher is accidentally lost.
  setTimeout(()=>process.kill(process.pid,'SIGTERM'),Math.min(remaining,2*60*60*1000)).unref();
})().catch(()=>{
  process.stderr.write('Acceptance mailbox preflight or isolated startup failed; no enrollment was started.\n');
  process.exitCode=1;
});
