'use strict';
const fs=require('node:fs');
const store=require('./document-store');
// Both owner and beneficiary controllers authorise before entering here. No
// filesystem path, token or secret is ever returned to the client.
function sendDocument(req,res,doc,mode='download') {
  let file;
  try {file=store.openDocument(doc);} catch {return res.status(404).json({error:'Managed document is missing or inaccessible'});}
  let stream;
  try {
    const name=String(store.toView(doc).display_name||'Document').toWellFormed().replace(/[\r\n"\\]/g,'_');
    const inline=mode==='preview'&&/^(application\/pdf|image\/(png|jpeg|webp)|audio\/(mpeg|mp4|wav)|video\/(mp4|quicktime))$/.test(doc.mime_type);
    res.set({'Content-Type':doc.mime_type,'X-Content-Type-Options':'nosniff','Cache-Control':'private, no-store',
      'Content-Security-Policy':"default-src 'none'; sandbox",'Accept-Ranges':'bytes',
      'Content-Disposition':`${inline?'inline':'attachment'}; filename="${name.replace(/[^\x20-\x7e]/g,'_')}"; filename*=UTF-8''${encodeURIComponent(name)}`});
    let start=0,end=file.size-1;
    if(req.headers.range) {
      const match=/^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
      const valid=match&&(match[1]||match[2])&&match.slice(1).every(x=>!x||Number.isSafeInteger(Number(x)));
      if(valid) {
        if(!match[1])start=Math.max(0,file.size-Number(match[2]));
        else {start=Number(match[1]);if(match[2])end=Math.min(Number(match[2]),file.size-1);}
      }
      if(!valid||!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||start>=file.size||end<start||(!match[1]&&Number(match[2])===0)) {
        fs.closeSync(file.fd);file=null;return res.status(416).set('Content-Range',`bytes */${doc.size_bytes}`).end();
      }
      res.status(206).set('Content-Range',`bytes ${start}-${end}/${file.size}`);
    }
    res.set('Content-Length',String(file.size?end-start+1:0));
    if(req.method==='HEAD'||!file.size) {fs.closeSync(file.fd);file=null;return res.end();}
    stream=fs.createReadStream(null,{fd:file.fd,autoClose:true,start,end});
    stream.on('error',()=>res.destroy());res.on('close',()=>stream.destroy());stream.pipe(res);
  } catch(e) {
    if(stream)stream.destroy();else if(file)fs.closeSync(file.fd);
    throw e;
  }
}
module.exports={sendDocument};
