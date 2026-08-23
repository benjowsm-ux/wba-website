/* ==========================================================================
   WBA — Block engine. Turns a list of blocks into HTML.
   Shared by the admin builder (live preview) and the post page.

   Block types: header · body · image · imagetext · button · link · section
   The build script (scripts/build-feed.mjs) contains a Node port of this
   renderer — if you add a block type, add it in both places.
   ========================================================================== */

function wbaEsc(s){
  var d = document.createElement('div');
  d.textContent = (s == null ? '' : s);
  return d.innerHTML;
}

function wbaMD(s){
  return (window.marked && s) ? marked.parse(s) : ('<p>' + wbaEsc(s).replace(/\n/g, '<br>') + '</p>');
}

/* Parse a stored body into a blocks array (or [] if it isn't blocks). */
function wbaParseBlocks(body){
  if(Array.isArray(body)) return body;
  if(typeof body !== 'string' || !body.trim()) return [];
  try{ var j = JSON.parse(body); return Array.isArray(j) ? j : []; }catch(e){ return []; }
}

/* Readable text colour for a custom background hex. */
function wbaTextOn(hex){
  try{
    var c = (hex || '').replace('#', '');
    if(c.length === 3) c = c[0]+c[0]+c[1]+c[1]+c[2]+c[2];
    var r = parseInt(c.substr(0,2),16), g = parseInt(c.substr(2,2),16), b = parseInt(c.substr(4,2),16);
    return ((r*299 + g*587 + b*114) / 1000) > 150 ? '#161d2b' : '#ffffff';
  }catch(e){ return '#161d2b'; }
}

var WBA_BG_PRESETS = ['mist','white','ink','gold'];

/* Wrap a block in a styled container if it carries a background or padding. */
function wbaWrapBlock(b, inner){
  if(!inner) return '';
  var cls = 'blk-wrap', style = '';
  if(b.bg){
    cls += ' has-bg';
    if(WBA_BG_PRESETS.indexOf(b.bg) > -1) cls += ' bg-' + b.bg;
    else style = ' style="background:' + wbaEsc(b.bg) + ';color:' + wbaTextOn(b.bg) + '"';
  }
  if(b.pad === 'sm') cls += ' pad-sm';
  else if(b.pad === 'lg') cls += ' pad-lg';
  if(cls === 'blk-wrap' && !style) return inner;
  return '<div class="' + cls + '"' + style + '>' + inner + '</div>';
}

/* Render a blocks array to HTML. */
function wbaRenderBlocks(blocks){
  if(!Array.isArray(blocks)) return '';
  return blocks.map(function(b){
    if(!b || !b.type) return '';
    var inner = '';
    switch(b.type){
      case 'header':
        var lv = (b.level === 3 ? 'h3' : 'h2');
        inner = '<' + lv + '>' + wbaEsc(b.text) + '</' + lv + '>';
        break;

      case 'body':
        inner = '<div class="blk-body">' + wbaMD(b.text) + '</div>';
        break;

      case 'image':
        if(!b.url) break;
        inner = '<figure class="blk-image"><img src="' + wbaEsc(b.url) + '" alt="' + wbaEsc(b.alt) + '" loading="lazy"/>'
              + ((b.caption && b.capOn !== false) ? '<figcaption>' + wbaEsc(b.caption) + '</figcaption>' : '')
              + '</figure>';
        break;

      case 'imagetext':
        var img = b.url
          ? '<div class="blk-it-img"><img src="' + wbaEsc(b.url) + '" alt="' + wbaEsc(b.alt) + '" loading="lazy"/></div>'
          : '';
        inner = '<div class="blk-imagetext' + (b.side === 'right' ? ' img-right' : '') + '">' + img
              + '<div class="blk-it-text">' + wbaMD(b.text) + '</div></div>';
        break;

      case 'button':
        inner = '<div class="blk-button"><a class="btn btn-primary" href="' + wbaEsc(b.url || '#') + '">'
              + wbaEsc(b.label || 'Button') + '</a></div>';
        break;

      case 'link':
        inner = '<p class="blk-link"><a class="link-go" href="' + wbaEsc(b.url || '#') + '">'
              + wbaEsc(b.text || b.url || 'Link') + '</a></p>';
        break;

      case 'section':
        inner = (b.heading ? '<h2>' + wbaEsc(b.heading) + '</h2>' : '') + (b.text ? wbaMD(b.text) : '');
        break;

      default:
        return '';
    }
    return wbaWrapBlock(b, inner);
  }).join('\n');
}

/* --------------------------------------------------------------------------
   Starter layouts. Pick one in the admin to get a pre-stacked skeleton —
   headings and prompts only, no content. Deliberately few: three shapes
   cover almost every post we write.
   -------------------------------------------------------------------------- */
var WBA_TEMPLATES = {
  guide: [
    { type:'header', level:2, text:'What this covers' },
    { type:'body',   text:'One or two lines: who this is for and what they walk away with.' },
    { type:'header', level:3, text:'Step one' },
    { type:'imagetext', side:'left',  text:'Describe the first step. Drop the screenshot or photo on the left.' },
    { type:'header', level:3, text:'Step two' },
    { type:'imagetext', side:'right', text:'The next step, with its image on the right.' },
    { type:'section', bg:'mist', heading:'The short version', text:'Pull out the single thing worth remembering.' },
    { type:'button', label:'Rather we did it?', url:'/contact/' }
  ],
  project: [
    { type:'header', level:2, text:'The brief' },
    { type:'body',   text:'What the business needed, and why.' },
    { type:'image',  url:'', alt:'', caption:'' },
    { type:'header', level:2, text:'What we built' },
    { type:'body',   text:'The work itself — decisions, not just deliverables.' },
    { type:'imagetext', side:'left', text:'A detail worth showing up close.' },
    { type:'section', bg:'ink', heading:'The outcome', text:'What changed for them afterwards.' },
    { type:'button', label:'Get in touch', url:'/contact/' }
  ],
  note: [
    { type:'header', level:2, text:'Headline' },
    { type:'body',   text:'The news or the point, in a sentence or two.' },
    { type:'body',   text:'A little more detail, and what it means for a local business.' },
    { type:'link',   text:'Read more', url:'' }
  ]
};
