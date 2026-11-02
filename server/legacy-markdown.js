'use strict';

// Deliberately small Markdown dialect: no HTML, images, remote embeds or CSS.
// Escape first and build only these constant tags. Links accept HTTPS/HTTP/mailto
// and never get fetched by the renderer (including tracking images).
function escape(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function inline(value) {
  const tokens = [];
  let source = String(value).replace(/\u0000/g, '');
  source = source.replace(/`([^`\n]+)`/g, (_, code) => `\u0000${tokens.push('<code>'+escape(code)+'</code>')-1}\u0000`);
  source = source.replace(/!?\[([^\]\n]+)\]\(([^\s)]+)\)/g, (whole, label, href) => {
    if (whole.startsWith('!')) return label;
    let safe = false;
    try { const url = new URL(href); safe = ['https:','http:','mailto:'].includes(url.protocol) && !/[\u0000-\u0020]/.test(href); } catch {}
    return `\u0000${tokens.push(safe ? `<a href="${escape(href)}" rel="noreferrer noopener" target="_blank">${escape(label)}</a>` : escape(label))-1}\u0000`;
  });
  return escape(source).replace(/\*\*([^*\n]+)\*\*/g,'<strong>$1</strong>')
    .replace(/\*([^*\n]+)\*/g,'<em>$1</em>')
    .replace(/\u0000(\d+)\u0000/g, (_, i) => tokens[Number(i)] || '');
}
function renderMarkdown(value) {
  const lines = String(value || '').slice(0,100000).replace(/\r\n?/g,'\n').split('\n');
  let output = '', list = '', code = null;
  const closeList = () => { if (list) output += `</${list}>`; list = ''; };
  for (const line of lines) {
    if (/^```/.test(line)) { closeList(); if (code !== null) { output += '<pre><code>'+escape(code.join('\n'))+'</code></pre>'; code = null; } else code = []; continue; }
    if (code !== null) { code.push(line); continue; }
    const match = line.match(/^\s*(?:([-*])|\d+\.)\s+(.+)$/);
    if (match) { const kind = match[1] ? 'ul' : 'ol'; if (list !== kind) { closeList(); list = kind; output += `<${kind}>`; } output += '<li>'+inline(match[2])+'</li>'; continue; }
    closeList();
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) output += `<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`;
    else if (/^>\s?/.test(line)) output += '<blockquote>'+inline(line.replace(/^>\s?/,''))+'</blockquote>';
    else if (line.trim()) output += '<p>'+inline(line)+'</p>';
  }
  closeList();
  if (code !== null) output += '<pre><code>'+escape(code.join('\n'))+'</code></pre>';
  return output;
}
module.exports = { renderMarkdown };
