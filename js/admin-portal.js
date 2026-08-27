/* ==========================================================================
   WBA — admin: Portal.

   Two jobs, and deliberately no others:

     1. Give a client a login.
     2. Put a site folder in front of them.

   The first version of this had invoices, payments, trials, monthly fees and
   an account register. All of it was scaffolding for a business process that
   already happens in GoCardless and your inbox, and none of it was the reason
   the portal exists. It is gone. The tables still exist in the database, so
   nothing was destroyed — they are simply not the job.

   THE UPLOAD
   Drop a folder. It reads every file in it, uploads them under
   <handle>/v<n>/… in a private bucket, and bumps the version. The client's
   next visit shows the new one. Nothing to name, nothing to configure, no
   CLI.
   ========================================================================== */
(function () {
  'use strict';

  var sb = window.sbc;
  if (!sb) return;

  var el = function (id) { return document.getElementById(id); };
  var current = null;        /* client id */
  var handle = null;         /* their handle — also their folder name */
  var projectId = null;

  function esc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function day(v) { return v ? new Date(v).toLocaleDateString('en-GB') : '—'; }

  function toast(m, bad) {
    var box = el('ptaMsg');
    if (!box) return;
    box.textContent = m;
    box.className = 'pta-msg' + (bad ? ' is-bad' : ' is-ok');
    clearTimeout(box._t);
    box._t = setTimeout(function () { box.textContent = ''; box.className = 'pta-msg'; }, 5000);
  }

  /* A blocked write returns 200 with an empty array, not an error. Checking
     only for r.error reports "Saved" while nothing happened. */
  function done(r, ok) {
    if (r.error) { toast(r.error.message, true); return false; }
    if (window.wbaWroteNothing && window.wbaWroteNothing(r)) {
      toast('The database refused that. Are you still signed in as an admin?', true);
      return false;
    }
    if (ok) toast(ok);
    return true;
  }

  /* ------------------------------------------------------------- the list */
  function loadClients() {
    return sb.from('clients').select('id,business').order('business').then(function (r) {
      var sel = el('ptaClient');
      if (!sel) return;
      sel.innerHTML = '<option value="">Choose a client…</option>' +
        (r.data || []).map(function (c) {
          return '<option value="' + esc(c.id) + '">' + esc(c.business || '(no name)') + '</option>';
        }).join('');
    });
  }

  function loadClient(id) {
    current = id; handle = null; projectId = null;
    if (!id) { el('ptaBody').hidden = true; return; }
    el('ptaBody').hidden = false;

    Promise.all([
      sb.from('client_users').select('*').eq('client_id', id),
      sb.from('projects').select('*').eq('client_id', id).order('created_at')
    ]).then(function (res) {
      var users = res[0].data || [];
      var projects = res[1].data || [];

      handle = users.length ? (users[0].handle || '').toLowerCase() : null;
      projectId = projects.length ? projects[0].id : null;

      renderUsers(users);
      renderSite(projects[0] || null);
      if (projectId) loadUpdates(projectId); else el('ptaUpdates').innerHTML = '';
    });
  }

  /* ------------------------------------------------------------ the login */
  function renderUsers(rows) {
    el('ptaUsers').innerHTML = rows.length
      ? '<table class="pta-t"><tr><th>Handle</th><th>Name</th><th>Last seen</th><th></th></tr>' +
        rows.map(function (u) {
          return '<tr><td><code>' + esc(u.handle || '—') + '</code></td>' +
                 '<td>' + esc(u.display_name || '—') + '</td>' +
                 '<td>' + esc(u.last_seen_at ? day(u.last_seen_at) : 'never') + '</td>' +
                 '<td><button type="button" class="admin-btn danger" data-unlink="' + esc(u.user_id) + '">Remove</button></td></tr>';
        }).join('') + '</table>'
      : '<p class="pta-none">No login yet. Make one below and they can sign in straight away.</p>';
  }

  function invite() {
    var email = (el('ptaEmail').value || '').trim();
    var h = (el('ptaHandle').value || '').trim().toLowerCase();
    var name = (el('ptaName').value || '').trim();
    if (!current) { toast('Pick a client first.', true); return; }
    if (email.indexOf('@') < 1) { toast('That email does not look right.', true); return; }
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(h)) {
      toast('Handle: lower case letters, numbers, dot, dash, underscore.', true); return;
    }

    var btn = el('ptaInvite');
    btn.disabled = true; btn.textContent = 'Creating…';

    sb.auth.getSession().then(function (s) {
      var token = s && s.data && s.data.session && s.data.session.access_token;
      return fetch('/api/portal-invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ client_id: current, email: email, handle: h, display_name: name })
      });
    }).then(function (r) { return r.json(); })
      .then(function (j) {
        btn.disabled = false; btn.textContent = 'Create login';
        if (j && j.ok) {
          toast('Done. They sign in at /portal/ with “' + h + '”.');
          el('ptaEmail').value = el('ptaHandle').value = el('ptaName').value = '';
          loadClient(current);
        } else {
          toast((j && j.error) || 'Could not create that login.', true);
        }
      })
      .catch(function () {
        btn.disabled = false; btn.textContent = 'Create login';
        toast('The portal-invite function is not deployed yet.', true);
      });
  }

  /* --------------------------------------------------------------- the site */
  function renderSite(project) {
    var box = el('ptaSite');
    if (!handle) {
      box.innerHTML = '<p class="pta-none">Make a login first — the handle is also the folder name for their files.</p>';
      el('ptaDrop').hidden = true;
      return;
    }
    el('ptaDrop').hidden = false;

    var v = project ? (project.preview_version || 0) : 0;
    box.innerHTML = v
      ? '<p class="pta-live">Version <b>' + esc(v) + '</b> is live for this client. ' +
        '<a href="/preview/' + esc(handle) + '/v' + esc(v) + '/" target="_blank" rel="noopener">Open it yourself</a></p>'
      : '<p class="pta-none">Nothing uploaded yet.</p>';
  }

  /* Reading a dropped folder.

     Two different APIs, because browsers give you two different things: a
     file INPUT with webkitdirectory hands over files that already carry a
     relative path, while a DRAG hands over a tree you have to walk yourself.
     Both end up as {path, file}. */
  function fromInput(input) {
    return Promise.resolve([].slice.call(input.files).map(function (f) {
      return { path: f.webkitRelativePath || f.name, file: f };
    }));
  }

  function fromDrop(dt) {
    var items = [].slice.call(dt.items || []);
    var roots = items.map(function (i) {
      return i.webkitGetAsEntry ? i.webkitGetAsEntry() : null;
    }).filter(Boolean);

    if (!roots.length) {
      return Promise.resolve([].slice.call(dt.files || []).map(function (f) {
        return { path: f.name, file: f };
      }));
    }

    var out = [];
    function walk(entry, prefix) {
      return new Promise(function (resolve) {
        if (entry.isFile) {
          entry.file(function (f) { out.push({ path: prefix + entry.name, file: f }); resolve(); },
                     function () { resolve(); });
          return;
        }
        var reader = entry.createReader();
        var kids = [];
        /* readEntries returns at most 100 at a time, so it has to be called
           until it returns nothing. Miss this and a big folder silently
           uploads its first hundred files. */
        (function next() {
          reader.readEntries(function (batch) {
            if (!batch.length) {
              Promise.all(kids.map(function (k) { return walk(k, prefix + entry.name + '/'); })).then(resolve);
              return;
            }
            kids = kids.concat([].slice.call(batch));
            next();
          }, function () { resolve(); });
        })();
      });
    }

    return Promise.all(roots.map(function (r) { return walk(r, ''); })).then(function () {
      /* A dropped folder arrives as "sitefolder/index.html". The folder's own
         name is ours, not theirs, so strip it — otherwise every preview URL
         carries a directory nobody chose. */
      var top = {};
      out.forEach(function (f) { top[f.path.split('/')[0]] = 1; });
      var names = Object.keys(top);
      if (names.length === 1 && out.every(function (f) { return f.path.indexOf('/') > 0; })) {
        var cut = names[0].length + 1;
        out.forEach(function (f) { f.path = f.path.slice(cut); });
      }
      return out;
    });
  }

  var SKIP = /(^|\/)(\.|node_modules\/|\.git\/|\.DS_Store|Thumbs\.db)/i;

  function upload(files) {
    if (!current) { toast('Pick a client first.', true); return; }
    if (!handle) { toast('Make a login first — the handle is the folder name.', true); return; }

    files = files.filter(function (f) { return f.path && !SKIP.test(f.path) && f.file.size > 0; });
    if (!files.length) { toast('No files in that.', true); return; }
    if (!files.some(function (f) { return /(^|\/)index\.html$/i.test(f.path); })) {
      if (!confirm('There is no index.html at the top of that folder. The client will land on a "not found" page. Upload anyway?')) return;
    }

    var bar = el('ptaBar');
    var fill = el('ptaFill');
    var label = el('ptaProgress');
    bar.hidden = false;

    /* Version first, so a half-finished upload never overwrites the version
       the client is currently looking at. They keep seeing v3 until v4 is
       entirely in place. */
    ensureProject().then(function (proj) {
      var version = (proj.preview_version || 0) + 1;
      var prefix = handle + '/v' + version + '/';
      var okCount = 0, failed = [];

      /* Four at a time. Serial is slow on a 200-file site; all at once
         collapses on a domestic upload and gives worse errors. */
      var queue = files.slice();
      function worker() {
        var next = queue.shift();
        if (!next) return Promise.resolve();
        return sb.storage.from('previews')
          .upload(prefix + next.path, next.file, { upsert: true, contentType: next.file.type || undefined })
          .then(function (r) {
            if (r.error) failed.push(next.path + ' — ' + r.error.message);
            else okCount++;
            var pct = Math.round(((okCount + failed.length) / files.length) * 100);
            fill.style.width = pct + '%';
            label.textContent = (okCount + failed.length) + ' of ' + files.length + ' files';
            return worker();
          });
      }

      return Promise.all([worker(), worker(), worker(), worker()]).then(function () {
        if (failed.length) {
          bar.hidden = true;
          toast(failed.length + ' file(s) failed. First: ' + failed[0], true);
          return;
        }
        return sb.from('projects')
          .update({ preview_version: version, preview_path: prefix.replace(/\/$/, ''), updated_at: new Date().toISOString() })
          .eq('id', proj.id).select('id')
          .then(function (r) {
            bar.hidden = true;
            if (!done(r)) return;
            return sb.from('project_updates').insert([{
              project_id: proj.id, kind: 'preview',
              title: 'New version of your site is up',
              body: 'Version ' + version + ' — have a look and tell us what to change.'
            }]).then(function () {
              toast('Uploaded. Version ' + version + ' is live for this client.');
              loadClient(current);
            });
          });
      });
    }).catch(function (e) {
      bar.hidden = true;
      toast('Upload failed: ' + (e && e.message ? e.message : e), true);
    });
  }

  /* A client has one site. If there is no project row yet, make one rather
     than asking the person uploading to go and create a record first. */
  function ensureProject() {
    if (projectId) {
      return sb.from('projects').select('*').eq('id', projectId).single()
        .then(function (r) { return r.data; });
    }
    return sb.from('projects')
      .insert([{ client_id: current, name: 'Website' }]).select('*').single()
      .then(function (r) {
        if (r.error) throw r.error;
        projectId = r.data.id;
        return r.data;
      });
  }

  /* --------------------------------------------------------------- updates */
  function loadUpdates(id) {
    sb.from('project_updates').select('*').eq('project_id', id)
      .order('happened_at', { ascending: false }).limit(8)
      .then(function (r) {
        var rows = r.data || [];
        el('ptaUpdates').innerHTML = rows.length
          ? '<ul class="pta-list">' + rows.map(function (u) {
              return '<li><b>' + esc(u.title) + '</b> <span>' + esc(day(u.happened_at)) + '</span>' +
                     '<button type="button" class="admin-btn danger" data-delupdate="' + esc(u.id) + '">×</button></li>';
            }).join('') + '</ul>'
          : '<p class="pta-none">Nothing posted.</p>';
      });
  }

  function addUpdate() {
    if (!projectId) { toast('Upload a site first.', true); return; }
    var title = (el('ptaUpTitle').value || '').trim();
    if (!title) return;
    sb.from('project_updates').insert([{ project_id: projectId, title: title }])
      .select('id').then(function (r) {
        if (done(r, 'Posted.')) { el('ptaUpTitle').value = ''; loadUpdates(projectId); }
      });
  }

  /* ------------------------------------------------------------ delegation */
  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!t || !t.dataset) return;
    if (t.dataset.delupdate) {
      sb.from('project_updates').delete().eq('id', t.dataset.delupdate).select('id')
        .then(function (r) { if (done(r, 'Removed.')) loadUpdates(projectId); });
    }
    if (t.dataset.unlink) {
      if (!confirm('Remove this login? They will not be able to sign in.')) return;
      sb.from('client_users').delete().eq('user_id', t.dataset.unlink).select('user_id')
        .then(function (r) { if (done(r, 'Login removed.')) loadClient(current); });
    }
  });

  /* ---------------------------------------------------------------- wiring */
  window.wbaLoadPortal = function () {
    if (window.wbaPortalLoaded) return;
    window.wbaPortalLoaded = true;

    loadClients();
    el('ptaClient').addEventListener('change', function () { loadClient(this.value); });
    el('ptaInvite').addEventListener('click', invite);
    el('ptaAddUpdate').addEventListener('click', addUpdate);

    var drop = el('ptaDrop');
    var picker = el('ptaPicker');

    picker.addEventListener('change', function () {
      fromInput(picker).then(upload);
      picker.value = '';
    });
    drop.addEventListener('click', function (e) {
      if (e.target.closest('label')) return;   /* the label already opens it */
      picker.click();
    });

    ['dragenter', 'dragover'].forEach(function (ev) {
      drop.addEventListener(ev, function (e) {
        e.preventDefault(); e.stopPropagation();
        drop.classList.add('is-over');
      });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      drop.addEventListener(ev, function (e) {
        e.preventDefault(); e.stopPropagation();
        if (ev === 'dragleave' && drop.contains(e.relatedTarget)) return;
        drop.classList.remove('is-over');
      });
    });
    drop.addEventListener('drop', function (e) {
      fromDrop(e.dataTransfer).then(upload);
    });
  };
})();
