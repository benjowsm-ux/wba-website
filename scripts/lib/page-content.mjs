/* ==========================================================================
   WBA — bake Edit-mode overrides into the static HTML.

   The browser sanitises what an admin types. This file sanitises it again on
   the way out, because those are two different trust boundaries: the first
   protects against a careless paste, the second against anything that reached
   the `page_content` table by another route — a stolen admin token, a direct
   REST call, a future bug in the editor. Whatever is in the database, only
   these tags survive into the HTML that ships.

   Kept dependency-free and separate from build-feed.mjs so it can be unit
   tested (`node scripts/test-page-content.mjs`) and lifted into another site.
   ========================================================================== */

/* Inline formatting a rich field may keep. Everything else is unwrapped: the
   words survive, the markup does not. */
const ALLOWED   = new Set(['b', 'strong', 'i', 'em', 'br', 'a', 'span']);
const SAFE_HREF = /^(https?:\/\/|\/|mailto:|tel:|#)/i;

/* The one attribute besides href that survives, and only with these exact
   values. Every big heading on this site sets its second line in
   <em class="accent">, and flattening that on the first edit would quietly
   undo the design. A class name cannot execute anything, so the risk here is
   visual, not security — an allow-list keeps it visual AND intended. */
const ALLOWED_CLASS = new Set(['accent']);

/* Elements with no closing tag — never editable, and worth naming so the
   build can say why instead of silently producing nothing. */
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img',
                      'input', 'link', 'meta', 'source', 'track', 'wbr']);

/* Index of the '>' that really ends the tag opened at `lt`.

   `indexOf('>')` is wrong: an attribute value may legally contain one, and
   `<a href="data:text/html,<script>">` would otherwise be cut in the middle,
   spilling the tail back into the page as text. Walk the tag tracking quote
   state instead. Returns -1 if the tag never closes. */
function findTagEnd(s, lt) {
  let quote = 0;
  for (let i = lt + 1; i < s.length; i++) {
    const ch = s[i];
    if (quote) { if (ch === quote) quote = 0; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '>') return i;
  }
  return -1;
}

/* Escape text for HTML, but leave already-encoded entities alone. The stored
   value came from innerHTML, so `&amp;` is already `&amp;` — escaping the
   ampersand again would print "&amp;amp;" on the page. */
export const escapeText = t => String(t == null ? '' : t)
  .replace(/&(?!#\d+;|#x[0-9a-fA-F]+;|[a-zA-Z][a-zA-Z0-9]*;)/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');

const escapeAttr = t => String(t == null ? '' : t)
  .replace(/&(?!#\d+;|#x[0-9a-fA-F]+;|[a-zA-Z][a-zA-Z0-9]*;)/g, '&amp;')
  .replace(/"/g, '&quot;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');

/* Returns ' class="accent"' or '' — never anything the allow-list rejects. */
function classAttr(attrs) {
  const m = /class\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(attrs || '');
  if (!m) return '';
  const kept = String(m[2] ?? m[3] ?? m[4] ?? '')
    .split(/\s+/)
    .filter(c => ALLOWED_CLASS.has(c));
  return kept.length ? ` class="${escapeAttr(kept.join(' '))}"` : '';
}

/* --------------------------------------------------------------------------
   sanitiseRich — allow-list, not deny-list.

   Anything not explicitly permitted is dropped. Unbalanced tags are closed at
   the end, so a truncated paste cannot swallow the rest of the page.
   -------------------------------------------------------------------------- */
export function sanitiseRich(html) {
  const s = String(html == null ? '' : html);
  const open = [];
  let out = '';
  let i = 0;

  while (i < s.length) {
    const lt = s.indexOf('<', i);
    if (lt === -1) { out += escapeText(s.slice(i)); break; }
    out += escapeText(s.slice(i, lt));

    /* A comment is never content we want to keep. */
    if (s.startsWith('<!--', lt)) {
      const end = s.indexOf('-->', lt + 4);
      i = end === -1 ? s.length : end + 3;
      continue;
    }

    const gt = findTagEnd(s, lt);
    if (gt === -1) { out += escapeText(s.slice(lt)); break; }

    const raw = s.slice(lt, gt + 1);
    const m = /^<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9]*)([\s\S]*?)\/?\s*>$/.exec(raw);

    /* Not a tag at all — a stray "<" in prose. Escape it and move on. */
    if (!m) { out += escapeText(raw); i = gt + 1; continue; }

    const closing = m[1] === '/';
    const name    = m[2].toLowerCase();
    const attrs   = m[3] || '';
    i = gt + 1;

    if (!ALLOWED.has(name)) continue;          // drop the tag, keep its text
    if (name === 'br')      { out += '<br/>'; continue; }

    if (closing) {
      /* Only close what we actually opened, and only in order. */
      if (open.length && open[open.length - 1] === name) {
        out += `</${name}>`;
        open.pop();
      }
      continue;
    }

    if (name === 'a') {
      const hm = /href\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(attrs);
      const href = hm ? String(hm[2] ?? hm[3] ?? hm[4] ?? '').trim() : '';
      if (SAFE_HREF.test(href)) {
        out += `<a href="${escapeAttr(href)}"${classAttr(attrs)}>`;
        open.push('a');
      }
      /* javascript:, data:, or no href — the link goes, the words stay. */
      continue;
    }

    /* A bare <span> carries no meaning; keep it only when it is doing the
       one styling job we permit. */
    const cls = classAttr(attrs);
    if (name === 'span' && !cls) continue;

    out += `<${name}${cls}>`;
    open.push(name);
  }

  while (open.length) out += `</${open.pop()}>`;
  return out.trim();
}

/* A plain-text field. Newlines survive as line breaks; nothing else does. */
export function renderText(value) {
  return escapeText(String(value == null ? '' : value))
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .join('<br/>');
}

export function renderValue(value, kind) {
  return kind === 'rich' ? sanitiseRich(value) : renderText(value);
}

/* --------------------------------------------------------------------------
   replaceEditable — swap the contents of the element carrying data-edit="key".

   Written as a scanner rather than a regex because the element usually has
   children (a <p> with a <strong> in it, say) and "match up to the first
   </p>" is wrong the moment anything nests. We find the opening tag, then
   walk forward counting same-name opens and closes until depth returns to 0.
   -------------------------------------------------------------------------- */
export function replaceEditable(html, key, innerHTML) {
  const needle = `data-edit="${key}"`;
  const at = html.indexOf(needle);
  if (at === -1) return { html, status: 'missing' };

  const lt = html.lastIndexOf('<', at);
  if (lt === -1) return { html, status: 'malformed' };
  const gt = findTagEnd(html, lt);
  if (gt === -1) return { html, status: 'malformed' };

  const nameM = /^<\s*([a-zA-Z][a-zA-Z0-9-]*)/.exec(html.slice(lt, gt + 1));
  if (!nameM) return { html, status: 'malformed' };

  const name = nameM[1].toLowerCase();
  if (VOID.has(name)) return { html, status: 'void' };

  const openRe  = new RegExp(`<${name}(?=[\\s/>])`, 'gi');
  const closeRe = new RegExp(`</${name}\\s*>`, 'gi');

  const start = gt + 1;
  let pos = start;
  let depth = 1;

  while (pos < html.length) {
    openRe.lastIndex = pos;
    closeRe.lastIndex = pos;
    const o = openRe.exec(html);
    const c = closeRe.exec(html);

    if (!c) return { html, status: 'unclosed' };

    if (o && o.index < c.index) { depth++; pos = o.index + o[0].length; continue; }

    depth--;
    if (depth === 0) {
      return {
        html: html.slice(0, start) + innerHTML + html.slice(c.index),
        status: 'ok'
      };
    }
    pos = c.index + c[0].length;
  }

  return { html, status: 'unclosed' };
}

/* Every data-edit key declared in a file, in document order. */
export function declaredKeys(html) {
  const out = [];
  const re = /data-edit="([^"]+)"/g;
  let m;
  while ((m = re.exec(html))) out.push(m[1]);
  return out;
}

/* '/sites/index.html' -> '/sites/', 'index.html' -> '/'  — the same shape
   js/edit.js derives from location.pathname, so the keys line up. */
export function pagePathFor(file) {
  let p = '/' + String(file).replace(/\\/g, '/');
  p = p.replace(/\/index\.html?$/i, '/');
  if (!p.endsWith('/') && /\.html?$/i.test(p)) return p;   // e.g. /404.html
  if (!p.endsWith('/')) p += '/';
  return p;
}
