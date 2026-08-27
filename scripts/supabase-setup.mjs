/* ==========================================================================
   WBA — do the Supabase setup, so nobody has to click through the dashboard.

     node scripts/supabase-setup.mjs           everything
     node scripts/supabase-setup.mjs sql       just the SQL
     node scripts/supabase-setup.mjs functions just the edge functions

   NEEDS a personal access token in `.env.supabase` (gitignored):

     SUPABASE_ACCESS_TOKEN=sbp_xxxxxxxx

   Get one at https://supabase.com/dashboard/account/tokens. It can be revoked
   from the same page the moment you want it gone, and nothing here writes it
   anywhere else or prints it.

   WHY A TOKEN AND NOT `supabase login`
   `supabase login` is interactive — it opens a browser and waits. That is
   fine for a human and impossible for a script. A token in a gitignored file
   is the standard non-interactive equivalent, and it is what CI uses.

   WHAT IT DOES
   SQL goes through the Management API rather than psql, because that needs
   only the token — no database password, no connection string, no extra
   binary to install. Functions go through the CLI, which reads
   supabase/config.toml and therefore gets the verify_jwt settings right
   every time instead of relying on a dashboard toggle that is known to flip
   itself back on.
   ========================================================================== */
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const REF = 'lynzhiyvggqyplssrapi';
const ONLY = process.argv[2] || 'all';

/* ---------------------------------------------------------------- token -- */
function token() {
  if (process.env.SUPABASE_ACCESS_TOKEN) return process.env.SUPABASE_ACCESS_TOKEN.trim();
  /* .txt too: Windows Notepad silently appends it to any filename that does
     not already have an extension, and "the file is definitely there" versus
     "no such file" is a miserable ten minutes to spend. */
  for (const f of ['.env.supabase', '.env.supabase.txt']) {
    if (!existsSync(f)) continue;
    const m = readFileSync(f, 'utf8').match(/SUPABASE_ACCESS_TOKEN\s*=\s*(\S+)/);
    if (m) return m[1].trim();
  }
  console.error(
    '\nNo access token.\n\n' +
    '  1. Go to https://supabase.com/dashboard/account/tokens\n' +
    '  2. Generate one, call it "wba-cli"\n' +
    '  3. Put it in a file called .env.supabase in this folder:\n\n' +
    '     SUPABASE_ACCESS_TOKEN=sbp_your_token_here\n\n' +
    'That file is gitignored. Revoke the token from the same page whenever you like.\n'
  );
  process.exit(1);
}
const TOKEN = token();

/* ------------------------------------------------------------------ sql -- */
const SQL_FILES = ['supabase/portal.sql', 'supabase/previews.sql'];

async function runSql() {
  for (const file of SQL_FILES) {
    if (!existsSync(file)) { console.log('· skipped (missing): ' + file); continue; }
    process.stdout.write('· ' + file + ' … ');

    const res = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: readFileSync(file, 'utf8') })
    });

    if (res.ok) { console.log('ok'); continue; }

    const body = await res.text();
    console.log('FAILED');
    console.error('  ' + res.status + ' ' + body.slice(0, 600));
    /* Stop rather than press on: previews.sql builds on portal.sql, and
       running the second against a half-made first produces a confusing
       error about the wrong thing. */
    process.exit(1);
  }
}

/* ------------------------------------------------------------ functions -- */
const FUNCTIONS = ['portal-login', 'portal-invite', 'preview'];

function deploy() {
  for (const fn of FUNCTIONS) {
    if (!existsSync(`supabase/functions/${fn}/index.ts`)) {
      console.log('· skipped (missing): ' + fn); continue;
    }
    process.stdout.write('· ' + fn + ' … ');
    try {
      /* shell:true on Windows is not laziness. Since the fix for
         CVE-2024-27980, Node refuses to spawn a .cmd file directly — and npx
         on Windows IS a .cmd. Without it this throws EINVAL and reports a
         perfectly successful deploy as a failure. */
      execFileSync(
        process.platform === 'win32' ? 'npx.cmd' : 'npx',
        ['supabase', 'functions', 'deploy', fn, '--project-ref', REF],
        {
          env: { ...process.env, SUPABASE_ACCESS_TOKEN: TOKEN },
          stdio: 'pipe',
          shell: process.platform === 'win32'
        }
      );
      console.log('deployed');
    } catch (e) {
      console.log('FAILED');
      const out = (e.stderr || e.stdout || Buffer.from('')).toString();
      console.error('  ' + out.split('\n').filter(Boolean).slice(-6).join('\n  '));
      process.exit(1);
    }
  }
}

/* ----------------------------------------------------------------- go ---- */
(async () => {
  if (ONLY === 'all' || ONLY === 'sql') {
    console.log('\nSQL');
    await runSql();
  }
  if (ONLY === 'all' || ONLY === 'functions') {
    console.log('\nEdge functions  (verify_jwt comes from supabase/config.toml)');
    deploy();
  }
  console.log('\nDone. Nothing else to click.\n');
})();
