#!/usr/bin/env node
'use strict';
// Explicit operator test only. This never opens the application database,
// enables workers, provisions credentials or changes a real check-in cycle.
require('dotenv').config({quiet:true});
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {createSmtpTransport}=require('../server/notifications/transport');
const {renderTemplate}=require('../server/notifications/templates');
const {normalizeAddress}=require('../server/notifications/parser');

async function main() {
  if(process.argv.length!==4 || process.argv[2]!=='--to' || !normalizeAddress(process.argv[3])) {
    process.stderr.write('Usage: node scripts/email-template-previews.js --to owner@example.com\n');return 2;
  }
  const recipient=normalizeAddress(process.argv[3]);
  const stamp=new Date().toISOString();
  const plus=days=>new Date(Date.parse(stamp)+days*86400000).toISOString();
  const samples=[];
  for(let days=5;days>=1;days--) samples.push({name:`reminder_${days}_days`,type:'reminder',payload:{releaseAt:plus(days),daysRemaining:days,
    reminderNumber:6-days,challenge:'WL-PREVIEW-NOT-A-VALID-CHALLENGE',challengeExpiresAt:plus(1)}});
  samples.push(
    {name:'checkin_confirmed',type:'checkin_confirmed',payload:{confirmedAt:stamp,nextCheckinAt:plus(30),nextReleaseAt:plus(37)}},
    {name:'checkin_failed',type:'checkin_failed',payload:{}},
    {name:'verify_address',type:'verify_address',payload:{verificationCode:'NV-PREVIEW-NOT-A-VALID-CODE',expiresAt:new Date(Date.parse(stamp)+1800000).toISOString()}},
    {name:'emergency_requested',type:'emergency_requested',payload:{beneficiaryName:'Example Beneficiary',requestedAt:stamp,waitingDays:7,eligibleAt:plus(7)}},
    ...['emergency_denied','access_granted','access_revoked','emergency_granted'].map(type=>({name:type,type,payload:{beneficiaryName:'Example Beneficiary',eventAt:stamp,accessGranted:['access_granted','emergency_granted'].includes(type)}})),
    {name:'deadswitch_released',type:'deadswitch_released',payload:{grantedAt:stamp}},
    {name:'email_test',type:'email_test',payload:{timestamp:stamp}},
    ...['degraded','recovered'].map(status=>({name:`transport_health_${status}`,type:'transport_health',payload:{timestamp:stamp,status}}))
  );
  const campaign=crypto.randomUUID();
  const directory=path.resolve(__dirname,'../data');
  fs.mkdirSync(directory,{recursive:true,mode:0o700});
  const evidence=path.join(directory,`email-template-previews-${campaign}.json`);
  const report={campaign,started_at:stamp,recipient_hash:crypto.createHash('sha256').update(recipient).digest('hex'),results:[]};
  const save=()=>fs.writeFileSync(evidence,JSON.stringify(report,null,2),{mode:0o600});
  const smtp=createSmtpTransport(process.env);
  const domain=process.env.SMTP_FROM.split('@').pop();
  const notice='TEMPLATE PREVIEW ONLY: fictional data and inactive example codes. No check-in, access grant, revocation or release has occurred. Do not reply with a real offline code.';
  try {
    await smtp.verify();
    process.stdout.write(`SMTP TLS/authentication verified. Sending ${samples.length} explicit template previews.\n`);
    for(const sample of samples) {
      const id=`<wl-preview-${campaign}-${sample.name}@${domain}>`;
      const rendered=renderTemplate(sample.type,sample.payload);
      const message={to:recipient,messageId:id,subject:`[PREVIEW] ${rendered.subject}`,
        text:notice+'\n\n'+rendered.text,
        html:rendered.html.replace('<main ',`<div role="note" style="max-width:600px;margin:0 auto 16px;padding:16px;background:#fff2cc;color:#332600;font:16px Arial">${notice}</div><main `)};
      report.results.push({template:sample.name,message_id:id,status:'sending',attempted_at:new Date().toISOString()});save();
      const row=report.results.at(-1);
      try {
        const result=await smtp.sendMail(message);
        row.status=result.status;row.accepted_count=result.acceptedCount;row.submitted_at=new Date().toISOString();save();
        process.stdout.write(`${sample.name}: sent_to_server\n`);
      } catch(error) {
        row.status=error.ambiguous?'uncertain':'failed';row.error=['SMTP_REJECTED','SMTP_UNAVAILABLE','EMAIL_CONFIGURATION'].includes(error.code)?error.code:'SMTP_UNAVAILABLE';save();
        process.stderr.write(`${sample.name}: ${row.status} (${row.error}); stopped without retrying.\n`);return 1;
      }
    }
    report.completed_at=new Date().toISOString();save();
    process.stdout.write(`Completed: ${samples.length} previews accepted by SMTP. Mailbox delivery requires separate confirmation.\n`);
    return 0;
  } catch(error) {
    report.error=['SMTP_REJECTED','SMTP_UNAVAILABLE','EMAIL_CONFIGURATION'].includes(error.code)?error.code:'SMTP_UNAVAILABLE';save();
    process.stderr.write(`SMTP verification failed (${report.error}). No automatic retry.\n`);return 1;
  } finally {smtp.close();}
}
if(require.main===module)main().then(code=>{process.exitCode=code;}).catch(()=>{process.stderr.write('Preview test failed; inspect sanitized local evidence before any retry.\n');process.exitCode=1;});
module.exports={main};
