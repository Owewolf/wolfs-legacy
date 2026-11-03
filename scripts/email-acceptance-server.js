#!/usr/bin/env node
'use strict';

// Explicit real-mail acceptance environment. Never import server/db or config:
// their paths point at the production checkout, so copy the application first.
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const http=require('node:http');
const {spawn}=require('node:child_process');
const dotenv=require('dotenv');

const MAIL_KEYS=['SMTP_HOST','SMTP_PORT','SMTP_SECURE','SMTP_USERNAME','SMTP_PASSWORD','SMTP_FROM',
  'CHECKIN_REPLY_MAILBOX','CHECKIN_IMAP_HOST','CHECKIN_IMAP_PORT','CHECKIN_IMAP_USERNAME','CHECKIN_IMAP_PASSWORD',
  'CHECKIN_IMAP_MAILBOX','CHECKIN_TRUSTED_AUTHSERV_IDS','EMAIL_MAX_MESSAGE_BYTES','EMAIL_MAX_MESSAGES_PER_POLL'];

function prepareAcceptance({repoRoot=path.resolve(__dirname,'..'),mailEnv={},allowRealEmail=false,port=4445}={}) {
  if(!Number.isSafeInteger(port)||port<1024||port>65535)throw new Error('Invalid local port');
  const staging=fs.mkdtempSync(path.join(os.tmpdir(),'wolfs-legacy-email-acceptance-'));
  fs.chmodSync(staging,0o700);
  for(const directory of ['server','public'])fs.cpSync(path.join(repoRoot,directory),path.join(staging,directory),{recursive:true});
  fs.symlinkSync(path.join(repoRoot,'node_modules'),path.join(staging,'node_modules'),'dir');
  for(const directory of ['data','managed-documents','empty-homebank'])fs.mkdirSync(path.join(staging,directory),{mode:0o700});
  // This isolated mail harness uses a pre-existing synthetic owner. It never
  // bypasses the production registration API or inherits a real SMS provider.
  const syntheticOwner={name:'Synthetic acceptance owner',email:'owner@example.invalid',password:crypto.randomBytes(24).toString('hex')};
  const syntheticOwnerFile=path.join(staging,'synthetic-owner.json');
  fs.writeFileSync(syntheticOwnerFile,JSON.stringify(syntheticOwner)+'\n',{mode:0o600});
  fs.copyFileSync(path.join(repoRoot,'scripts/email-acceptance/route.js'),path.join(staging,'server/acceptance-route.js'));
  fs.copyFileSync(path.join(repoRoot,'scripts/email-acceptance/client.js'),path.join(staging,'public/js/acceptance.js'));
  fs.copyFileSync(path.join(repoRoot,'scripts/email-acceptance/bootstrap.js'),path.join(staging,'bootstrap.js'));
  fs.copyFileSync(path.join(repoRoot,'scripts/email-acceptance/mailbox.js'),path.join(staging,'acceptance-mailbox.js'));
  fs.appendFileSync(path.join(staging,'server/notifications/templates.js'),`\n// Disposable-provider-acceptance markings; production source is unchanged.\nconst acceptanceRender = module.exports.renderTemplate;\nmodule.exports.renderTemplate = (...args) => {\n  const message = acceptanceRender(...args);\n  const banner = 'ACCEPTANCE TEST: Disposable synthetic vault. This message does not describe your production vault.';\n  return { ...message, subject: '[ACCEPTANCE TEST] ' + message.subject, text: banner + '\\n\\n' + message.text,\n    html: message.html.replace(/(<body[^>]*>)/i, '$1<p style="padding:16px;background:#073c4c;color:#fff;font-weight:bold">' + banner + '</p>') };\n};\n`);
  const indexFile=path.join(staging,'server/index.js');
  let index=fs.readFileSync(indexFile,'utf8');
  if(!index.includes('process.env.LISTEN_HOST'))throw new Error('Application must support an explicit loopback host');
  if(!index.includes('const app = express();'))throw new Error('Application initialization changed');
  index=index.replace('const app = express();',"const app = express();\napp.use((req,res,next)=>{res.set('X-Wolfs-Legacy-Acceptance',process.env.EMAIL_ACCEPTANCE_ID);next();});");
  const insertion="app.use('/api/auth', require('./routes/auth'));";
  if(index.split(insertion).length!==2)throw new Error('Application route insertion point changed');
  index=index.replace(insertion,"app.use('/api/notifications/acceptance', require('./acceptance-route'));\n"+insertion);
  fs.writeFileSync(indexFile,index,{mode:0o600});
  const htmlFile=path.join(staging,'public/index.html');
  fs.writeFileSync(htmlFile,fs.readFileSync(htmlFile,'utf8').replace('</body>','  <script src="/js/acceptance.js"></script>\n</body>'),{mode:0o600});
  const childEnv={PATH:process.env.PATH||'/usr/bin:/bin',LANG:'C.UTF-8',TZ:'Africa/Johannesburg',NODE_ENV:'production',
    PORT:String(port),LISTEN_HOST:'127.0.0.1',JWT_SECRET:crypto.randomBytes(32).toString('hex'),
    ENCRYPTION_KEY:crypto.randomBytes(32).toString('hex'),NOTIFICATION_SECRET:crypto.randomBytes(32).toString('hex'),
    NOTIFICATIONS_ENABLED:allowRealEmail?'true':'false',NOTIFICATION_TIMEZONE:'Africa/Johannesburg',NOTIFICATION_REMINDER_DAYS:'5',AUTH_SMS_REQUIRED:'false',
    HOMEBANK_OWNER_EMAIL:'',HOMEBANK_DIRECTORY:path.join(staging,'empty-homebank'),HOMEBANK_ALLOWED_ROOT:path.join(staging,'empty-homebank'),
    DOCUMENT_STORAGE_ROOT:path.join(staging,'managed-documents'),EMAIL_ACCEPTANCE_ROOT:staging,EMAIL_ACCEPTANCE_ID:crypto.randomUUID(),
    EMAIL_ACCEPTANCE_EXPIRES_AT:new Date(Date.now()+2*60*60*1000).toISOString()};
  for(const key of MAIL_KEYS)if(typeof mailEnv[key]==='string')childEnv[key]=mailEnv[key];
  // No .env, original data, private files, source HomeBank directory or alternate
  // alert executable is copied/inherited. Secrets live only in child memory.
  return {staging,childEnv,indexFile,bootstrapFile:path.join(staging,'bootstrap.js'),port,syntheticOwner,syntheticOwnerFile};
}

function waitForReady(child,port,acceptanceId,timeout=45000) {
  return new Promise((resolve,reject)=>{
    const started=Date.now();
    const poll=()=>{
      if(!child.pid||child.exitCode!==null||child.signalCode)return reject(new Error('Acceptance server stopped during startup'));
      const request=http.get({hostname:'127.0.0.1',port,path:'/health',timeout:750},response=>{
        response.resume();
        if(response.statusCode===200&&response.headers['x-wolfs-legacy-acceptance']===acceptanceId)return resolve();
        retry();
      });
      request.on('timeout',()=>request.destroy());
      request.on('error',retry);
    };
    const retry=()=>Date.now()-started>=timeout?reject(new Error('Acceptance server startup timed out')):setTimeout(poll,100);
    poll();
  });
}

async function run(args) {
  if(args.length!==1||args[0]!=='--allow-real-email') {
    process.stderr.write('Usage: node scripts/email-acceptance-server.js --allow-real-email\nCreates a private disposable vault on http://127.0.0.1:4445 and uses configured SMTP/IMAP.\n');
    return 2;
  }
  const repoRoot=path.resolve(__dirname,'..');
  const mailEnv={...dotenv.parse(fs.readFileSync(path.join(repoRoot,'.env')))};
  for(const key of ['SMTP_HOST','SMTP_USERNAME','SMTP_PASSWORD','SMTP_FROM','CHECKIN_REPLY_MAILBOX','CHECKIN_IMAP_HOST','CHECKIN_IMAP_USERNAME','CHECKIN_IMAP_PASSWORD']) {
    if(!mailEnv[key])throw new Error('Complete local SMTP/IMAP settings before starting acceptance');
  }
  const sessionFile=path.join(repoRoot,'data/email-acceptance-session.json');
  if(fs.existsSync(sessionFile)) {
    const old=JSON.parse(fs.readFileSync(sessionFile,'utf8'));
    try {
      if(fs.readFileSync(`/proc/${old.pid}/cmdline`,'utf8').includes(old.staging))throw new Error('An acceptance session is already running');
    } catch(error) {if(error.message==='An acceptance session is already running')throw error;}
    fs.copyFileSync(sessionFile,sessionFile.replace(/\.json$/,`.previous-${Date.now()}.json`));
  }
  const prepared=prepareAcceptance({repoRoot,mailEnv,allowRealEmail:true});
  const logFile=path.join(prepared.staging,'server.log');
  const log=fs.openSync(logFile,'a',0o600);
  const child=spawn(process.execPath,[prepared.bootstrapFile],{cwd:prepared.staging,env:prepared.childEnv,stdio:['ignore',log,log]});
  fs.closeSync(log);
  let stopping=false,stopReason;
  const stop=(reason='operator_stop')=>{if(!stopping){stopping=true;stopReason=reason;child.kill('SIGTERM');}};
  process.once('SIGINT',()=>stop());process.once('SIGTERM',()=>stop());
  const expiryTimer=setTimeout(()=>stop('lifetime_expired'),Math.max(0,new Date(prepared.childEnv.EMAIL_ACCEPTANCE_EXPIRES_AT)-Date.now()));
  expiryTimer.unref();
  const ended=new Promise(resolve=>{child.once('exit',(code,signal)=>resolve({code,signal}));child.once('error',()=>resolve({code:1,signal:null}));});
  child.once('error',()=>stop());
  try {await waitForReady(child,prepared.port,prepared.childEnv.EMAIL_ACCEPTANCE_ID);}catch(error){stop();await ended;throw error;}
  const metadata={staging:prepared.staging,pid:child.pid,launcher_pid:process.pid,port:prepared.port,
    url:`http://127.0.0.1:${prepared.port}/#login`,acceptance_id:prepared.childEnv.EMAIL_ACCEPTANCE_ID,
    started_at:new Date().toISOString(),expires_at:prepared.childEnv.EMAIL_ACCEPTANCE_EXPIRES_AT,log_file:logFile,
    initial_mailbox_checkpoint:JSON.parse(fs.readFileSync(path.join(prepared.staging,'mailbox-checkpoint.json'),'utf8'))};
  fs.mkdirSync(path.dirname(sessionFile),{recursive:true,mode:0o700});
  fs.writeFileSync(sessionFile,JSON.stringify(metadata,null,2)+'\n',{mode:0o600});fs.chmodSync(sessionFile,0o600);
  process.stdout.write(`Isolated acceptance UI: ${metadata.url}\nSession metadata: ${sessionFile}\nSynthetic sign-in credentials: ${prepared.syntheticOwnerFile}\nSign in with the disposable owner, then open Settings. Real email is enabled only in this disposable instance.\n`);
  const result=await ended;
  clearTimeout(expiryTimer);
  metadata.stopped_at=new Date().toISOString();metadata.exit_code=result.code;metadata.exit_signal=result.signal;
  metadata.stop_reason=stopReason||'child_stopped';
  fs.writeFileSync(sessionFile,JSON.stringify(metadata,null,2)+'\n',{mode:0o600});
  process.stdout.write('Acceptance server stopped; private staging evidence has been preserved.\n');
  return stopping||result.code===0?0:1;
}

if(require.main===module)run(process.argv.slice(2)).then(code=>{process.exitCode=code;}).catch(()=>{
  // Never print source env, errors containing message content, or secret values.
  process.stderr.write('Acceptance harness could not start. Check private session metadata, local configuration and port availability.\n');process.exitCode=1;
});
module.exports={prepareAcceptance,waitForReady};
