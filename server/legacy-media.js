'use strict';
const fs=require('node:fs');
// Strip ancillary image metadata from NEW protected uploads, preserving source
// files on the owner's computer. No image processor or external URL is used.
function stripPhotoMetadata(filename,mime) {
  if(!['image/jpeg','image/png','image/webp'].includes(mime)) return;
  const data=fs.readFileSync(filename),parts=[];
  if(mime==='image/jpeg') {
    parts.push(data.subarray(0,2));let pos=2;
    while(pos<data.length) {
      const start=pos;
      if(data[pos]!==255) throw new Error('Invalid JPEG structure');
      while(data[pos]===255)pos++;
      const kind=data[pos++];
      if(kind===0xda||kind===0xd9) {parts.push(data.subarray(start));pos=data.length;break;}
      if(kind===0x01||(kind>=0xd0&&kind<=0xd7)) {parts.push(data.subarray(start,pos));continue;}
      if(pos+2>data.length) throw new Error('Invalid JPEG structure');
      const length=data.readUInt16BE(pos);if(length<2||pos+length>data.length)throw new Error('Invalid JPEG segment');
      if(![0xe1,0xed,0xfe].includes(kind))parts.push(data.subarray(start,pos+length));
      pos+=length;
    }
  } else if(mime==='image/png') {
    parts.push(data.subarray(0,8));let pos=8,ended=false;
    while(pos+12<=data.length) {
      const length=data.readUInt32BE(pos),end=pos+12+length;if(end>data.length)throw new Error('Invalid PNG structure');
      const kind=data.toString('ascii',pos+4,pos+8);
      if(['IHDR','PLTE','IDAT','IEND','tRNS'].includes(kind))parts.push(data.subarray(pos,end));
      pos=end;if(kind==='IEND') {ended=true;break;}
    }
    if(!ended)throw new Error('Incomplete PNG');
  } else {
    let pos=12;const chunks=[];
    while(pos+8<=data.length) {
      const length=data.readUInt32LE(pos+4),end=pos+8+length+(length%2);if(end>data.length)throw new Error('Invalid WebP structure');
      const kind=data.toString('ascii',pos,pos+4);
      if(!['EXIF','XMP '].includes(kind)) {const chunk=Buffer.from(data.subarray(pos,end));if(kind==='VP8X'&&chunk.length>8)chunk[8]&=~0x0c;chunks.push(chunk);}
      pos=end;
    }
    if(pos!==data.length)throw new Error('Incomplete WebP');
    const header=Buffer.from(data.subarray(0,12));header.writeUInt32LE(4+chunks.reduce((n,b)=>n+b.length,0),4);parts.push(header,...chunks);
  }
  fs.writeFileSync(filename,Buffer.concat(parts),{mode:0o600});
}
module.exports={stripPhotoMetadata};
