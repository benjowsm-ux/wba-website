/* ==========================================================================
   WBA — tests for the Edit-mode bake step.

     node scripts/test-page-content.mjs

   The sanitiser is the boundary between "whatever ended up in the database"
   and "HTML we serve to the public", so it gets tested like one. Every XSS
   case below is a real technique, not a strawman.
   ========================================================================== */

import {
  sanitiseRich, renderText, renderValue,
  replaceEditable, declaredKeys, pagePathFor
} from './lib/page-content.mjs';

let pass = 0, fail = 0;

function is(actual, expected, label) {
  if (actual === expected) { pass++; return; }
  fail++;
  console.error(`FAIL  ${label}`);
  console.error(`      expected: ${JSON.stringify(expected)}`);
  console.error(`      actual:   ${JSON.stringify(actual)}`);
}

function contains(actual, needle, label, want = true) {
  const has = String(actual).includes(needle);
  if (has === want) { pass++; return; }
  fail++;
  console.error(`FAIL  ${label}`);
  console.error(`      ${want ? 'expected to contain' : 'must NOT contain'}: ${JSON.stringify(needle)}`);
  console.error(`      actual: ${JSON.stringify(actual)}`);
}

/* ----------------------------------------------------- XSS: script tags -- */
contains(sanitiseRich('<script>alert(1)</script>'), '<script', 'script tag dropped', false);
contains(sanitiseRich('hi <script>alert(1)</script> there'), 'alert(1)', 'script text is kept but inert', true);
is(sanitiseRich('<SCRIPT>x</SCRIPT>'), 'x', 'uppercase SCRIPT dropped');
contains(sanitiseRich('<scr<script>ipt>alert(1)</script>'), '<script', 'nested/split script tag', false);

/* ------------------------------------------------ XSS: event handlers ---- */
is(sanitiseRich('<b onclick="steal()">hi</b>'), '<b>hi</b>', 'onclick stripped from allowed tag');
is(sanitiseRich('<b ONCLICK=steal()>hi</b>'), '<b>hi</b>', 'unquoted uppercase handler stripped');
contains(sanitiseRich('<img src=x onerror=alert(1)>'), 'onerror', 'img with onerror removed entirely', false);
contains(sanitiseRich('<svg onload=alert(1)></svg>'), 'onload', 'svg dropped', false);

/* ------------------------------------------------------- XSS: hrefs ------ */
is(sanitiseRich('<a href="javascript:alert(1)">x</a>'), 'x', 'javascript: link unwrapped');
is(sanitiseRich('<a href="JaVaScRiPt:alert(1)">x</a>'), 'x', 'mixed-case javascript: unwrapped');
is(sanitiseRich('<a href="data:text/html,<script>">x</a>'), 'x', 'data: link unwrapped');
is(sanitiseRich('<a href=" javascript:alert(1)">x</a>'), 'x', 'leading-space javascript: unwrapped');
is(sanitiseRich('<a>x</a>'), 'x', 'anchor with no href unwrapped');
is(sanitiseRich('<a href="/sites/">x</a>'), '<a href="/sites/">x</a>', 'root-relative link kept');
is(sanitiseRich('<a href="https://a.co">x</a>'), '<a href="https://a.co">x</a>', 'https link kept');
is(sanitiseRich('<a href="mailto:a@b.co">x</a>'), '<a href="mailto:a@b.co">x</a>', 'mailto kept');
is(sanitiseRich('<a href="#start">x</a>'), '<a href="#start">x</a>', 'fragment kept');
is(sanitiseRich('<a href="/x" target="_blank" onmouseover="p()">x</a>'),
   '<a href="/x">x</a>', 'extra attributes stripped, href kept');

/* --------------------------------------------------- allowed formatting -- */
is(sanitiseRich('<strong>a</strong> and <em>b</em>'), '<strong>a</strong> and <em>b</em>', 'strong/em kept');
is(sanitiseRich('a<br>b'), 'a<br/>b', 'br normalised');
is(sanitiseRich('a<br/>b'), 'a<br/>b', 'self-closed br kept');
is(sanitiseRich('<p>para</p>'), 'para', 'block tag unwrapped, text kept');
is(sanitiseRich('<div><span>x</span></div>'), 'x', 'nested block tags unwrapped');

/* --------------------------------------------------- broken / hostile ---- */
is(sanitiseRich('<b>unclosed'), '<b>unclosed</b>', 'unclosed tag is closed');
is(sanitiseRich('</b>orphan'), 'orphan', 'orphan close dropped');
is(sanitiseRich('<b><i>x</b></i>'), '<b><i>x</i></b>', 'mis-nesting repaired in order');
is(sanitiseRich('a < b'), 'a &lt; b', 'stray less-than escaped');
is(sanitiseRich('<!-- comment -->text'), 'text', 'comment dropped');
is(sanitiseRich('<b>x'.repeat(3)), '<b>x<b>x<b>x</b></b></b>', 'repeated unclosed tags all closed');

/* ------------------------------------------------ the class allow-list --- */
is(sanitiseRich('<em class="accent">Grow.</em>'), '<em class="accent">Grow.</em>', 'accent class kept');
is(sanitiseRich('<span class="accent">x</span>'), '<span class="accent">x</span>', 'accent span kept');
is(sanitiseRich('<em class="evil">x</em>'), '<em>x</em>', 'unlisted class dropped, tag kept');
is(sanitiseRich('<em class="accent evil">x</em>'), '<em class="accent">x</em>', 'only listed classes survive');
is(sanitiseRich('<span>bare</span>'), 'bare', 'span with no permitted class is unwrapped');
is(sanitiseRich('<span class="evil">x</span>'), 'x', 'span with only an unlisted class unwrapped');
is(sanitiseRich('<em class="accent" onclick="x()">y</em>'), '<em class="accent">y</em>',
   'handler stripped while accent survives');
is(sanitiseRich('Free sites.<br><em class="accent">No build fee.</em>'),
   'Free sites.<br/><em class="accent">No build fee.</em>', 'real heading round trips intact');

/* ------------------------------- attributes containing '>' (regression) -- */
is(sanitiseRich('<b title="a>b">x</b>'), '<b>x</b>', 'quoted attribute containing > does not split the tag');
is(sanitiseRich("<b title='a>b'>x</b>"), '<b>x</b>', 'single-quoted attribute containing >');
is(sanitiseRich('<span title="a>b">x</span>'), 'x', 'dropped tag with > in attribute leaves no residue');
is(sanitiseRich('<a href="/x?a=1&amp;b=2">y</a>'), '<a href="/x?a=1&amp;b=2">y</a>', 'query string entity preserved');
is(sanitiseRich('<a href="/x?a=1&b=2">y</a>'), '<a href="/x?a=1&amp;b=2">y</a>', 'bare ampersand in href escaped');
/* An href that isn't on the allow-list is dropped outright, quotes and all. */
is(sanitiseRich('<a href=\'"onmouseover="x\'>y</a>'), 'y',
   'href that is not a permitted scheme is unwrapped, not repaired');
/* The one that matters: a permitted scheme carrying a quote-escape attempt.
   It stays one attribute because the quote is entity-encoded on output. */
is(sanitiseRich('<a href=\'/x" onmouseover="alert(1)\'>y</a>'),
   '<a href="/x&quot; onmouseover=&quot;alert(1)">y</a>',
   'quote inside an allowed href cannot start a second attribute');
{
  const h = '<p data-edit="k" title="a>b">old</p>';
  is(replaceEditable(h, 'k', 'N').html, '<p data-edit="k" title="a>b">N</p>',
     'replaceEditable survives > inside a later attribute');
}

/* ------------------------------------------------------ entity handling -- */
is(sanitiseRich('Ben &amp; Co'), 'Ben &amp; Co', 'existing entity not double-escaped');
is(sanitiseRich('Ben & Co'), 'Ben &amp; Co', 'bare ampersand escaped');
is(sanitiseRich('&lt;script&gt;'), '&lt;script&gt;', 'already-escaped script stays escaped');
is(renderText('a & b'), 'a &amp; b', 'text: bare ampersand escaped');
is(renderText('<b>bold</b>'), '&lt;b&gt;bold&lt;/b&gt;', 'text: markup shown literally, not rendered');
is(renderText('one\ntwo'), 'one<br/>two', 'text: newline becomes a break');
is(renderText('one\r\ntwo'), 'one<br/>two', 'text: CRLF becomes one break');

/* ------------------------------------------------------- renderValue ----- */
is(renderValue('<b>x</b>', 'rich'), '<b>x</b>', 'rich passes formatting');
is(renderValue('<b>x</b>', 'text'), '&lt;b&gt;x&lt;/b&gt;', 'text escapes formatting');
is(renderValue('<b>x</b>', undefined), '&lt;b&gt;x&lt;/b&gt;', 'missing kind defaults to text');

/* -------------------------------------------------- replaceEditable ------ */
{
  const h = '<h1 data-edit="hero.title">Old</h1>';
  const r = replaceEditable(h, 'hero.title', 'New');
  is(r.status, 'ok', 'simple replace status');
  is(r.html, '<h1 data-edit="hero.title">New</h1>', 'simple replace result');
}
{
  /* the case a regex gets wrong */
  const h = '<p data-edit="k">Hello <strong>you</strong> there</p><p>after</p>';
  const r = replaceEditable(h, 'k', 'X');
  is(r.html, '<p data-edit="k">X</p><p>after</p>', 'children replaced, next sibling intact');
}
{
  /* same-name nesting: depth counting must not stop at the inner close */
  const h = '<div data-edit="k">a<div>b</div>c</div><div>outside</div>';
  const r = replaceEditable(h, 'k', 'X');
  is(r.html, '<div data-edit="k">X</div><div>outside</div>', 'nested same-name element handled');
}
{
  const h = '<p class="x" data-edit="k" id="y">old</p>';
  is(replaceEditable(h, 'k', 'N').html, '<p class="x" data-edit="k" id="y">N</p>',
     'attributes around data-edit preserved');
}
{
  const h = '<h2 data-edit="a">one</h2><h2 data-edit="b">two</h2>';
  const r1 = replaceEditable(h, 'b', 'TWO');
  is(r1.html, '<h2 data-edit="a">one</h2><h2 data-edit="b">TWO</h2>', 'second key targeted correctly');
}
is(replaceEditable('<p>none</p>', 'nope', 'X').status, 'missing', 'absent key reported');
is(replaceEditable('<img data-edit="k"/>', 'k', 'X').status, 'void', 'void element refused');
is(replaceEditable('<p data-edit="k">x', 'k', 'X').status, 'unclosed', 'unclosed element refused');
{
  /* a key that is a prefix of another must not match the longer one */
  const h = '<p data-edit="intro">A</p><p data-edit="intro.body">B</p>';
  const r = replaceEditable(h, 'intro', 'X');
  is(r.html, '<p data-edit="intro">X</p><p data-edit="intro.body">B</p>', 'prefix key does not match longer key');
}

/* ----------------------------------------------------- declaredKeys ------ */
is(declaredKeys('<h1 data-edit="a">x</h1><p data-edit="b.c">y</p>').join(','), 'a,b.c', 'keys listed in order');
is(declaredKeys('<p>nothing</p>').length, 0, 'no keys found');

/* ------------------------------------------------------- pagePathFor ----- */
is(pagePathFor('index.html'), '/', 'root page path');
is(pagePathFor('sites/index.html'), '/sites/', 'section page path');
is(pagePathFor('feed/a-post/index.html'), '/feed/a-post/', 'nested page path');
is(pagePathFor('404.html'), '/404.html', 'standalone html keeps its name');
is(pagePathFor('sites\\index.html'), '/sites/', 'windows separators normalised');

/* --------------------------------------------------- end-to-end round ---- */
{
  const page = '<h1 data-edit="t">Old title</h1><p data-edit="b" data-edit-kind="rich">Old body</p>';
  let out = page;
  out = replaceEditable(out, 't', renderValue('New & improved', 'text')).html;
  out = replaceEditable(out, 'b', renderValue('Say <b>hi</b><script>x</script>', 'rich')).html;
  is(out,
     '<h1 data-edit="t">New &amp; improved</h1>' +
     '<p data-edit="b" data-edit-kind="rich">Say <b>hi</b>x</p>',
     'full round trip: escaped text, sanitised rich, script neutralised');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
