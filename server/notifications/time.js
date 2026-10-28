'use strict';
const DAY = 86400000;
function utc(value) {
  if (value instanceof Date || typeof value === 'number') {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) throw new Error('Invalid timestamp');
    return date;
  }
  // Legacy SQLite CURRENT_TIMESTAMP is UTC despite lacking a zone suffix.
  const text = String(value || '');
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text) ? text.replace(' ', 'T') + 'Z' : text;
  const date = new Date(normalized);
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid timestamp');
  return date;
}
function parts(value, timezone) {
  const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  return Object.fromEntries(fmt.formatToParts(utc(value)).filter(p => p.type !== 'literal').map(p => [p.type, Number(p.value)]));
}
function localDate(value, timezone) {
  const p = parts(value, timezone);
  return `${p.year}-${String(p.month).padStart(2,'0')}-${String(p.day).padStart(2,'0')}`;
}
function validTimezone(zone) { try { parts(new Date().toISOString(), zone); return typeof zone === 'string' && zone.length < 100; } catch { return false; } }
function fromLocal(p, timezone) {
  const wall = Date.UTC(p.year,p.month-1,p.day,p.hour,p.minute,p.second || 0);
  let candidate = wall;
  for (let i=0;i<4;i++) {
    const actual = parts(new Date(candidate).toISOString(), timezone);
    const offset = Date.UTC(actual.year,actual.month-1,actual.day,actual.hour,actual.minute,actual.second) - candidate;
    const next = wall-offset;
    if (next === candidate) break;
    candidate=next;
  }
  const result = parts(new Date(candidate).toISOString(), timezone);
  if (['year','month','day','hour','minute','second'].some(k => result[k] !== (p[k] || 0))) return null;
  return new Date(candidate).toISOString();
}
function deadlines(last, interval, grace) {
  const base=utc(last).getTime();
  return { lastCheckinAt: new Date(base).toISOString(), nextCheckinAt: new Date(base+interval*DAY).toISOString(),
    releaseAt: new Date(base+(interval+grace)*DAY).toISOString() };
}
function reminderSlots(expiry, timezone='Africa/Johannesburg', clock=null) {
  const p=parts(expiry,timezone);
  const out=[];
  for(let remaining=5;remaining>=1;remaining--) {
    const day=new Date(Date.UTC(p.year,p.month-1,p.day-remaining));
    const [hour,minute]=clock ? clock.split(':').map(Number) : [p.hour,p.minute];
    const at=fromLocal({year:day.getUTCFullYear(),month:day.getUTCMonth()+1,day:day.getUTCDate(),hour,minute,second:clock?0:p.second},timezone);
    if(at && utc(at)<utc(expiry)) out.push({at,daysRemaining:remaining,number:6-remaining,date:localDate(at,timezone)});
  }
  return out;
}
module.exports={DAY,utc,parts,localDate,validTimezone,deadlines,reminderSlots};
