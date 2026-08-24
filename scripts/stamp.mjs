/* ==========================================================================
   WBA — stamp CSS and JS with a content hash. Standalone.

     node scripts/stamp.mjs

   The full build does this too (build-feed.mjs, last step), but the full
   build needs a database. This is the same operation on its own so a local
   CSS change can be checked in a browser without one.

   WHY IT EXISTS AT ALL, so nobody deletes it:
   netlify.toml caches /css/* and /js/* for a year and serves HTML with
   max-age=0. Without a hash in the URL a returning visitor gets brand new
   markup against a cached stylesheet, every new component renders unstyled,
   and it looks exactly like the deploy failed. A changed file must be a
   changed URL.
   ========================================================================== */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';

const hashOf = f => createHash('sha1').update(readFileSync(f)).digest('hex').slice(0, 10);

const versions = new Map();
const add = f => { if (existsSync(f)) versions.set('/' + f, hashOf(f)); };
add('css/styles.css');
for (const e of readdirSync('js', { withFileTypes: true })) {
  if (e.isFile() && e.name.endsWith('.js')) add('js/' + e.name);
}

const files = [];
(function scan(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = dir === '.' ? e.name : dir + '/' + e.name;
    if (e.isDirectory()) {
      if (['node_modules', '.git', '.github', 'scripts', 'supabase', 'photos', 'img', 'css', 'js', '.claude'].includes(e.name)) continue;
      scan(full);
    } else if (/\.html?$/i.test(e.name)) files.push(full);
  }
})('.');

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

let touched = 0;
for (const file of files) {
  let html = readFileSync(file, 'utf8');
  const before = html;
  for (const [path, hash] of versions) {
    const re = new RegExp('(["\'(])' + escapeRe(path) + '(?:\\?v=[a-f0-9]+)?(["\')])', 'g');
    html = html.replace(re, '$1' + path + '?v=' + hash + '$2');
  }
  if (html !== before) { writeFileSync(file, html); touched++; }
}
console.log('Stamped ' + versions.size + ' asset(s) across ' + touched + ' page(s).');

/* --------------------------------------------------------------------------
   Optional assets.

   Some of the decoration is supplied later — the messaging-window frame over
   the homepage photograph is the current example. Referencing it from CSS
   before it exists means a 404 on every page load; removing the reference by
   hand means remembering to put it back. So the build decides: the class that
   carries the background is present exactly when the file is.
   -------------------------------------------------------------------------- */
const OPTIONAL = [
  { file: 'img/ws-frame.png', cls: 'has-frame', on: 'ws-chrome' }
];

function toggleOptional(files) {
  for (const { file, cls, on } of OPTIONAL) {
    const present = existsSync(file);
    for (const page of files) {
      let html = readFileSync(page, 'utf8');
      const before = html;
      const withCls = new RegExp('class="' + on + ' ' + cls + '"', 'g');
      const without = new RegExp('class="' + on + '"', 'g');
      html = present
        ? html.replace(without, 'class="' + on + ' ' + cls + '"')
        : html.replace(withCls, 'class="' + on + '"');
      if (html !== before) writeFileSync(page, html);
    }
    console.log((present ? 'Optional: ' + file + ' present — .' + cls + ' on.'
                         : 'Optional: ' + file + ' missing — .' + cls + ' off (no 404).'));
  }
}
toggleOptional(files);
