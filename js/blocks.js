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
              + ((b.caption && b.capOn !== false) ? '<figcaption>' + wbaEsc(b.caption) + '</figcaption>' : '') + '</figure>'; break;
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

/* Built-in starter templates — pre-stacked block layouts per content type. */
var WBA_TEMPLATES = {
  tutorial: [
    {type:'header',level:2,text:'How to [do the thing]'},
    {type:'body',text:'A quick intro — who this is for and what they\'ll walk away with.'},
    {type:'imagetext',side:'left',text:'**Step 1 —** describe the first step here.'},
    {type:'imagetext',side:'right',text:'**Step 2 —** describe the next step.'},
    {type:'imagetext',side:'left',text:'**Step 3 —** and the one after that.'},
    {type:'section',bg:'cream',heading:'And that\'s it',text:'Wrap up — what they\'ve achieved and what to do next.'},
    {type:'button',label:'Want us to do it for you?',url:'contact.html'}
  ],
  review: [
    {type:'header',level:2,text:'[Thing] — our honest review'},
    {type:'body',text:'Set the scene: what it is and why it matters to local businesses.'},
    {type:'section',bg:'cream',heading:'👍 The good',text:'- Point one\n- Point two\n- Point three'},
    {type:'section',bg:'cream',heading:'👎 The not-so-good',text:'- Point one\n- Point two'},
    {type:'header',level:3,text:'The verdict'},
    {type:'body',text:'Your overall take, in a couple of lines.'},
    {type:'button',label:'Get help with yours',url:'contact.html'}
  ],
  listicle: [
    {type:'header',level:2,text:'7 [things] every Weston business should [do]'},
    {type:'body',text:'One-line intro to the list.'},
    {type:'header',level:3,text:'1. First thing'},{type:'body',text:'Why it matters.'},
    {type:'header',level:3,text:'2. Second thing'},{type:'body',text:'Why it matters.'},
    {type:'header',level:3,text:'3. Third thing'},{type:'body',text:'Why it matters.'},
    {type:'button',label:'Book a free visit',url:'contact.html'}
  ],
  news: [
    {type:'header',level:2,text:'[Headline]'},
    {type:'body',text:'What happened, in a sentence or two.'},
    {type:'section',bg:'navy',heading:'The key bit',text:'Pull out the single most important point.'},
    {type:'body',text:'More detail, and what it means for local businesses.'},
    {type:'button',label:'Talk to WBA',url:'contact.html'}
  ]
};

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
