/* ==========================================================================
   WBA — make the hero panels editable.

   The panels carry the facts most likely to change: the monthly price, the
   phone number, how quickly we reply, whether we are taking work. Edit mode
   exists precisely so those can be changed without a rewrite, so shipping
   them as fixed markup would be a step backwards.

   The wrapping matters. A .hp-v holds both the value and its sub-line:

     <span class="hp-v">£30<span class="sub">Hosting…</span></span>

   Putting data-edit on .hp-v itself would hand the editor both at once, and
   saving would flatten the sub-line into the value. So the value text gets
   its own span and the sub keeps its own key.

   Idempotent — a panel that already has data-edit attributes is skipped.
   ========================================================================== */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (['node_modules', '.git', '.github', 'scripts', 'supabase', 'photos', 'img', 'css', 'js'].includes(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.html?$/i.test(name)) out.push(full);
  }
  return out;
}

let done = 0, skipped = 0;

for (const file of walk(ROOT)) {
  let html = readFileSync(file, 'utf8');
  if (!html.includes('class="win hero-panel"')) continue;
  if (html.includes('data-edit="panel.')) { skipped++; continue; }

  const start = html.indexOf('<aside class="win hero-panel"');
  const end = html.indexOf('</aside>', start) + '</aside>'.length;
  let panel = html.slice(start, end);

  /* Title and the live chip. */
  panel = panel.replace(
    /<span class="win-title">([\s\S]*?)<\/span>/,
    (m, t) => `<span class="win-title" data-edit="panel.title">${t}</span>`
  );
  panel = panel.replace(
    /<span class="hp-live"><i aria-hidden="true"><\/i>([\s\S]*?)<\/span>/,
    (m, t) => `<span class="hp-live"><i aria-hidden="true"></i><span data-edit="panel.live">${t}</span></span>`
  );

  /* Each row: key, value, optional sub-line. */
  let n = 0;
  panel = panel.replace(
    /<span class="hp-k">([\s\S]*?)<\/span>\s*<span class="hp-v">([\s\S]*?)<\/span>\s*<\/div>/g,
    (m, k, v) => {
      n++;
      const subMatch = v.match(/<span class="sub">([\s\S]*?)<\/span>/);
      const value = v.replace(/<span class="sub">[\s\S]*?<\/span>/, '').trim();
      const sub = subMatch
        ? `<span class="sub" data-edit="panel.s${n}">${subMatch[1]}</span>`
        : '';
      return `<span class="hp-k" data-edit="panel.k${n}">${k}</span>\n` +
             `          <span class="hp-v"><span data-edit="panel.v${n}" data-edit-kind="rich">${value}</span>${sub}</span>\n` +
             `        </div>`;
    }
  );

  writeFileSync(file, html.slice(0, start) + panel + html.slice(end));
  console.log('· ' + file.slice(ROOT.length + 1).split('\\').join('/') + '  (' + n + ' rows)');
  done++;
}

console.log('\nPanels made editable: ' + done + (skipped ? ', already done: ' + skipped : ''));
