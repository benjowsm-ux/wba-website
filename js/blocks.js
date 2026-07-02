/* ==========================================================================
   WBA — Block engine. Turns a list of blocks into HTML.
   Shared by the admin builder (preview) and the live post page.
   Block types: header · body · image · imagetext · button · link · section
   ========================================================================== */

function wbaEsc(s){ var d = document.createElement('div'); d.textContent = (s == null ? '' : s); return d.innerHTML; }
function wbaMD(s){ return (window.marked && s) ? marked.parse(s) : ('<p>' + wbaEsc(s).replace(/\n/g, '<br>') + '</p>'); }

/* Parse a stored body into a blocks array (or [] if it's not blocks). */
function wbaParseBlocks(body){
  if(Array.isArray(body)) return body;
  if(typeof body !== 'string' || !body.trim()) return [];
  try { var j = JSON.parse(body); return Array.isArray(j) ? j : []; } catch(e){ return []; }
}

/* Render a blocks array to HTML. */
function wbaRenderBlocks(blocks){
  if(!Array.isArray(blocks)) return '';
  return blocks.map(function(b){
    if(!b || !b.type) return '';
    switch(b.type){
      case 'header':
        var lv = (b.level === 3 ? 'h3' : 'h2');
        return '<' + lv + '>' + wbaEsc(b.text) + '</' + lv + '>';
      case 'body':
        return '<div class="blk-body">' + wbaMD(b.text) + '</div>';
      case 'image':
        if(!b.url) return '';
        return '<figure class="blk-image"><img src="' + wbaEsc(b.url) + '" alt="' + wbaEsc(b.alt) + '" loading="lazy"/>'
             + (b.caption ? '<figcaption>' + wbaEsc(b.caption) + '</figcaption>' : '') + '</figure>';
      case 'imagetext':
        var img = b.url ? '<div class="blk-it-img"><img src="' + wbaEsc(b.url) + '" alt="' + wbaEsc(b.alt) + '" loading="lazy"/></div>' : '';
        return '<div class="blk-imagetext' + (b.side === 'right' ? ' img-right' : '') + '">' + img
             + '<div class="blk-it-text">' + wbaMD(b.text) + '</div></div>';
      case 'button':
        return '<div class="blk-button"><a class="btn-primary" href="' + wbaEsc(b.url || '#') + '">' + wbaEsc(b.label || 'Button') + '</a></div>';
      case 'link':
        return '<p class="blk-link"><a href="' + wbaEsc(b.url || '#') + '">' + wbaEsc(b.text || b.url || 'Link') + ' →</a></p>';
      case 'section':
        return '<div class="blk-section bg-' + wbaEsc(b.bg || 'cream') + '">'
             + (b.heading ? '<h2>' + wbaEsc(b.heading) + '</h2>' : '')
             + (b.text ? wbaMD(b.text) : '') + '</div>';
      default: return '';
    }
  }).join('\n');
}

/* Turn pasted AI text into blocks (headings + paragraphs + markdown images). */
function wbaParseAIText(text){
  var out = [];
  (text || '').split(/\n\s*\n/).forEach(function(chunk){
    var t = chunk.trim();
    if(!t) return;
    var img = t.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
    if(img){ out.push({ type:'image', url: img[2], alt: img[1], caption:'' }); return; }
    if(/^#\s+/.test(t)){ out.push({ type:'header', level:2, text: t.replace(/^#\s+/, '') }); return; }
    if(/^##\s+/.test(t)){ out.push({ type:'header', level:3, text: t.replace(/^##\s+/, '') }); return; }
    out.push({ type:'body', text: t });
  });
  return out;
}
