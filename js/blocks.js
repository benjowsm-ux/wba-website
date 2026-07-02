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

/* Pick readable text colour for a custom background hex. */
function wbaTextOn(hex){
  try{ var c=(hex||'').replace('#',''); if(c.length===3) c=c[0]+c[0]+c[1]+c[1]+c[2]+c[2];
    var r=parseInt(c.substr(0,2),16),g=parseInt(c.substr(2,2),16),bl=parseInt(c.substr(4,2),16);
    return ((r*299+g*587+bl*114)/1000) > 150 ? '#1a1f2e' : '#ffffff';
  }catch(e){ return '#1a1f2e'; }
}
/* Wrap a block in a styled container if it has a background/padding. */
function wbaWrapBlock(b, inner){
  if(!inner) return '';
  var cls='blk-wrap', style='', preset=['cream','white','navy','gold'];
  if(b.bg){ cls+=' has-bg'; if(preset.indexOf(b.bg)>-1) cls+=' bg-'+b.bg; else style=' style="background:'+wbaEsc(b.bg)+';color:'+wbaTextOn(b.bg)+'"'; }
  if(b.pad==='sm') cls+=' pad-sm'; else if(b.pad==='lg') cls+=' pad-lg';
  if(cls==='blk-wrap' && !style) return inner;
  return '<div class="'+cls+'"'+style+'>'+inner+'</div>';
}

/* Render a blocks array to HTML. */
function wbaRenderBlocks(blocks){
  if(!Array.isArray(blocks)) return '';
  return blocks.map(function(b){
    if(!b || !b.type) return '';
    var inner = '';
    switch(b.type){
      case 'header':
        var lv = (b.level === 3 ? 'h3' : 'h2'); inner = '<' + lv + '>' + wbaEsc(b.text) + '</' + lv + '>'; break;
      case 'body':
        inner = '<div class="blk-body">' + wbaMD(b.text) + '</div>'; break;
      case 'image':
        if(!b.url) break;
        inner = '<figure class="blk-image"><img src="' + wbaEsc(b.url) + '" alt="' + wbaEsc(b.alt) + '" loading="lazy"/>'
              + (b.caption ? '<figcaption>' + wbaEsc(b.caption) + '</figcaption>' : '') + '</figure>'; break;
      case 'imagetext':
        var img = b.url ? '<div class="blk-it-img"><img src="' + wbaEsc(b.url) + '" alt="' + wbaEsc(b.alt) + '" loading="lazy"/></div>' : '';
        inner = '<div class="blk-imagetext' + (b.side === 'right' ? ' img-right' : '') + '">' + img
              + '<div class="blk-it-text">' + wbaMD(b.text) + '</div></div>'; break;
      case 'button':
        inner = '<div class="blk-button"><a class="btn-primary" href="' + wbaEsc(b.url || '#') + '">' + wbaEsc(b.label || 'Button') + '</a></div>'; break;
      case 'link':
        inner = '<p class="blk-link"><a href="' + wbaEsc(b.url || '#') + '">' + wbaEsc(b.text || b.url || 'Link') + ' →</a></p>'; break;
      case 'section':
        inner = (b.heading ? '<h2>' + wbaEsc(b.heading) + '</h2>' : '') + (b.text ? wbaMD(b.text) : ''); break;
      default: return '';
    }
    return wbaWrapBlock(b, inner);
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
