/* ==========================================================================
   WBA — admin: the Portal tab.

   Everything the client portal shows is put here: who can sign in, what
   project they are on, what has happened, what we billed and what arrived.

   ONE IDEA RUNS THROUGH THIS FILE
   The client side is read-only. Every write happens in the admin, as an
   admin, and row-level security enforces that in the database rather than
   here — so a bug in this file cannot become a way for a client to change
   their own invoice. What this file owes you is that it never *appears* to
   have saved something it did not, which is why every write is checked with
   wbaWroteNothing() rather than only for an error.

   AND ONE THING IT WILL NOT DO
   There is no password field anywhere in the account editor, on purpose.
   See the header of supabase/portal.sql.
   ========================================================================== */
(function () {
  'use strict';

  var sb = window.sbc;
  if (!sb) return;

  var el = function (id) { return document.getElementById(id); };
  var current = null;                    /* the client we are editing */

  function esc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function money(p) { return '£' + ((Number(p) || 0) / 100).toFixed(2); }
  function pence(v) { return Math.round((parseFloat(v) || 0) * 100); }
  function day(v) { return v ? new Date(v).toLocaleDateString('en-GB') : '—'; }

  function toast(m, bad) {
    var box = el('ptaMsg');
    if (!box) return;
    box.textContent = m;
    box.className = 'pta-msg' + (bad ? ' is-bad' : ' is-ok');
    clearTimeout(box._t);
    box._t = setTimeout(function () { box.textContent = ''; box.className = 'pta-msg'; }, 4000);
  }

  /* A blocked write comes back 200 with an empty array, not an error — the
     single most expensive thing to forget with row-level security. */
  function done(r, ok) {
    if (r.error) { toast(r.error.message, true); return false; }
    if (window.wbaWroteNothing && window.wbaWroteNothing(r)) {
      toast('The database refused that write. Are you still signed in as an admin?', true);
      return false;
    }
    toast(ok || 'Saved.');
    return true;
  }

  /* ------------------------------------------------------------- the list */
  function loadClients() {
    return sb.from('clients').select('id,business,status').order('business')
      .then(function (r) {
        var sel = el('ptaClient');
        if (!sel) return;
        var rows = r.data || [];
        sel.innerHTML = '<option value="">Choose a client…</option>' +
          rows.map(function (c) {
            return '<option value="' + esc(c.id) + '">' + esc(c.business || '(no name)') + '</option>';
          }).join('');
      });
  }

  function loadClient(id) {
    current = id;
    if (!id) { el('ptaBody').hidden = true; return; }
    el('ptaBody').hidden = false;

    Promise.all([
      sb.from('client_users').select('*').eq('client_id', id),
      sb.from('projects').select('*').eq('client_id', id).order('created_at'),
      sb.from('invoices').select('*').eq('client_id', id).order('issued_on', { ascending: false }),
      sb.from('payments').select('*').eq('client_id', id).order('paid_on', { ascending: false }),
      sb.from('project_accounts').select('*').eq('client_id', id).order('label')
    ]).then(function (res) {
      renderUsers(res[0].data || []);
      renderProjects(res[1].data || []);
      renderInvoices(res[2].data || []);
      renderPayments(res[3].data || []);
      renderAccounts(res[4].data || []);
      var p = (res[1].data || [])[0];
      if (p) loadUpdates(p.id); else el('ptaUpdates').innerHTML = '<p class="pta-none">Add a project first.</p>';
    });
  }

  /* ------------------------------------------------------------ portal users */
  function renderUsers(rows) {
    el('ptaUsers').innerHTML = rows.length
      ? '<table class="pta-t"><tr><th>Handle</th><th>Name</th><th>Last seen</th><th></th></tr>' +
        rows.map(function (u) {
          return '<tr><td><code>' + esc(u.handle || '—') + '</code></td>' +
                 '<td>' + esc(u.display_name || '—') + '</td>' +
                 '<td>' + esc(u.last_seen_at ? day(u.last_seen_at) : 'never') + '</td>' +
                 '<td><button type="button" class="admin-btn danger" data-unlink="' + esc(u.user_id) + '">Unlink</button></td></tr>';
        }).join('') + '</table>'
      : '<p class="pta-none">Nobody can sign in for this client yet.</p>';
  }

  /* Creating the auth user needs the service key, which must never be in a
     browser. So this asks the Edge Function to do it, and the admin's own
     token is what authorises the request. */
  function invite() {
    var email = (el('ptaEmail').value || '').trim();
    var handle = (el('ptaHandle').value || '').trim().toLowerCase();
    var name = (el('ptaName').value || '').trim();
    if (!current) { toast('Pick a client first.', true); return; }
    if (!email || email.indexOf('@') < 1) { toast('That email does not look right.', true); return; }
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(handle)) {
      toast('Handles are lower case letters, numbers, dot, dash, underscore.', true); return;
    }

    sb.auth.getSession().then(function (s) {
      var token = s && s.data && s.data.session && s.data.session.access_token;
      return fetch('/api/portal-invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ client_id: current, email: email, handle: handle, display_name: name })
      });
    }).then(function (r) { return r.json(); })
      .then(function (j) {
        if (j && j.ok) {
          toast('Invited. They can sign in with “' + handle + '”.');
          el('ptaEmail').value = el('ptaHandle').value = el('ptaName').value = '';
          loadClient(current);
        } else {
          toast((j && j.error) || 'Could not create that login.', true);
        }
      })
      .catch(function () { toast('The invite endpoint is not deployed yet — see docs/PORTAL.md.', true); });
  }

  /* ---------------------------------------------------------------- projects */
  var STAGES = ['talk', 'design', 'build', 'live', 'grow'];

  function renderProjects(rows) {
    el('ptaProjects').innerHTML = rows.length
      ? rows.map(function (p) {
          return '<div class="pta-row" data-project="' + esc(p.id) + '">' +
            '<input class="pta-in" value="' + esc(p.name) + '" data-f="name"/>' +
            '<select class="pta-in" data-f="stage">' + STAGES.map(function (s) {
              return '<option' + (s === p.stage ? ' selected' : '') + '>' + s + '</option>';
            }).join('') + '</select>' +
            '<input class="pta-in" value="' + esc(p.live_url || '') + '" data-f="live_url" placeholder="live url"/>' +
            '<button type="button" class="admin-btn" data-saveproject="' + esc(p.id) + '">Save</button>' +
            '</div>';
        }).join('')
      : '<p class="pta-none">No project yet.</p>';
  }

  function addProject() {
    if (!current) return;
    var name = (el('ptaNewProject').value || '').trim();
    if (!name) return;
    sb.from('projects').insert([{ client_id: current, name: name }]).select('id')
      .then(function (r) { if (done(r, 'Project added.')) { el('ptaNewProject').value = ''; loadClient(current); } });
  }

  /* ---------------------------------------------------------------- updates */
  function loadUpdates(projectId) {
    el('ptaUpdates').dataset.project = projectId;
    sb.from('project_updates').select('*').eq('project_id', projectId)
      .order('happened_at', { ascending: false }).limit(15)
      .then(function (r) {
        var rows = r.data || [];
        el('ptaUpdates').innerHTML = rows.length
          ? '<ul class="pta-list">' + rows.map(function (u) {
              return '<li><b>' + esc(u.title) + '</b> <span>' + esc(day(u.happened_at)) + '</span>' +
                     '<button type="button" class="admin-btn danger" data-delupdate="' + esc(u.id) + '">×</button></li>';
            }).join('') + '</ul>'
          : '<p class="pta-none">Nothing posted yet.</p>';
      });
  }

  function addUpdate() {
    var projectId = el('ptaUpdates').dataset.project;
    if (!projectId) { toast('Add a project first.', true); return; }
    var title = (el('ptaUpTitle').value || '').trim();
    if (!title) return;
    sb.from('project_updates').insert([{
      project_id: projectId,
      title: title,
      body: (el('ptaUpBody').value || '').trim() || null,
      kind: el('ptaUpKind').value
    }]).select('id').then(function (r) {
      if (done(r, 'Posted. The client sees it immediately.')) {
        el('ptaUpTitle').value = ''; el('ptaUpBody').value = '';
        loadUpdates(projectId);
      }
    });
  }

  /* ---------------------------------------------------------------- money */
  function renderInvoices(rows) {
    el('ptaInvoices').innerHTML = rows.length
      ? '<table class="pta-t"><tr><th>Number</th><th>Issued</th><th>Amount</th><th>Status</th><th></th></tr>' +
        rows.map(function (i) {
          return '<tr><td>' + esc(i.number) + '</td><td>' + esc(day(i.issued_on)) + '</td>' +
                 '<td>' + money(i.amount_pence) + '</td>' +
                 '<td><select class="pta-in tiny" data-invstatus="' + esc(i.id) + '">' +
                 ['draft', 'sent', 'paid', 'overdue', 'void'].map(function (s) {
                   return '<option' + (s === i.status ? ' selected' : '') + '>' + s + '</option>';
                 }).join('') + '</select></td>' +
                 '<td><button type="button" class="admin-btn danger" data-delinvoice="' + esc(i.id) + '">×</button></td></tr>';
        }).join('') + '</table>' +
        '<p class="pta-hint">Drafts are invisible to the client. They appear the moment you set one to “sent”.</p>'
      : '<p class="pta-none">No invoices.</p>';
  }

  function addInvoice() {
    if (!current) return;
    var number = (el('ptaInvNo').value || '').trim();
    var amount = el('ptaInvAmt').value;
    if (!number || !amount) { toast('Number and amount, please.', true); return; }
    sb.from('invoices').insert([{
      client_id: current, number: number, amount_pence: pence(amount),
      status: 'draft', note: (el('ptaInvNote').value || '').trim() || null
    }]).select('id').then(function (r) {
      if (done(r, 'Invoice added as a draft.')) { el('ptaInvNo').value = ''; el('ptaInvAmt').value = ''; loadClient(current); }
    });
  }

  function renderPayments(rows) {
    el('ptaPayments').innerHTML = rows.length
      ? '<table class="pta-t"><tr><th>Date</th><th>Method</th><th>Amount</th><th></th></tr>' +
        rows.map(function (p) {
          return '<tr><td>' + esc(day(p.paid_on)) + '</td><td>' + esc(p.method || '—') + '</td>' +
                 '<td>' + money(p.amount_pence) + '</td>' +
                 '<td><button type="button" class="admin-btn danger" data-delpayment="' + esc(p.id) + '">×</button></td></tr>';
        }).join('') + '</table>'
      : '<p class="pta-none">Nothing recorded.</p>';
  }

  function addPayment() {
    if (!current) return;
    var amount = el('ptaPayAmt').value;
    if (!amount) return;
    sb.from('payments').insert([{
      client_id: current, amount_pence: pence(amount),
      method: (el('ptaPayMethod').value || '').trim() || null,
      reference: (el('ptaPayRef').value || '').trim() || null
    }]).select('id').then(function (r) {
      if (done(r, 'Payment recorded.')) { el('ptaPayAmt').value = ''; el('ptaPayRef').value = ''; loadClient(current); }
    });
  }

  /* -------------------------------------------------------------- accounts */
  function renderAccounts(rows) {
    el('ptaAccounts').innerHTML = rows.length
      ? '<table class="pta-t"><tr><th>Label</th><th>Username</th><th>Held by</th><th></th></tr>' +
        rows.map(function (a) {
          return '<tr><td>' + esc(a.label) + '</td><td><code>' + esc(a.username || '—') + '</code></td>' +
                 '<td>' + esc(a.holder) + '</td>' +
                 '<td><button type="button" class="admin-btn danger" data-delaccount="' + esc(a.id) + '">×</button></td></tr>';
        }).join('') + '</table>'
      : '<p class="pta-none">No accounts recorded.</p>';
  }

  function addAccount() {
    if (!current) return;
    var label = (el('ptaAccLabel').value || '').trim();
    if (!label) return;
    sb.from('project_accounts').insert([{
      client_id: current, label: label,
      url: (el('ptaAccUrl').value || '').trim() || null,
      username: (el('ptaAccUser').value || '').trim() || null,
      holder: el('ptaAccHolder').value,
      vault_url: (el('ptaAccVault').value || '').trim() || null
    }]).select('id').then(function (r) {
      if (done(r, 'Account noted.')) {
        ['ptaAccLabel', 'ptaAccUrl', 'ptaAccUser', 'ptaAccVault'].forEach(function (i) { el(i).value = ''; });
        loadClient(current);
      }
    });
  }

  /* ------------------------------------------------------------- delegation
     One listener for the whole panel rather than a handler per row, so the
     lists can be re-rendered freely without leaking listeners. */
  function del(table, id, label) {
    if (!confirm('Delete this ' + label + '? This cannot be undone.')) return;
    sb.from(table).delete().eq('id', id).select('id')
      .then(function (r) { if (done(r, 'Deleted.')) loadClient(current); });
  }

  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!t || !t.getAttribute) return;

    if (t.dataset.delinvoice) return del('invoices', t.dataset.delinvoice, 'invoice');
    if (t.dataset.delpayment) return del('payments', t.dataset.delpayment, 'payment');
    if (t.dataset.delaccount) return del('project_accounts', t.dataset.delaccount, 'account');
    if (t.dataset.delupdate) {
      var pid = el('ptaUpdates').dataset.project;
      return sb.from('project_updates').delete().eq('id', t.dataset.delupdate).select('id')
        .then(function (r) { if (done(r, 'Removed.')) loadUpdates(pid); });
    }
    if (t.dataset.unlink) {
      if (!confirm('Remove this login? They will no longer be able to sign in.')) return;
      return sb.from('client_users').delete().eq('user_id', t.dataset.unlink).select('user_id')
        .then(function (r) { if (done(r, 'Login removed.')) loadClient(current); });
    }
    if (t.dataset.saveproject) {
      var row = t.closest('.pta-row');
      var patch = {};
      row.querySelectorAll('[data-f]').forEach(function (i) { patch[i.dataset.f] = i.value || null; });
      patch.updated_at = new Date().toISOString();
      return sb.from('projects').update(patch).eq('id', t.dataset.saveproject).select('id')
        .then(function (r) { done(r, 'Project saved.'); });
    }
  });

  document.addEventListener('change', function (e) {
    var t = e.target;
    if (t && t.dataset && t.dataset.invstatus) {
      sb.from('invoices').update({ status: t.value }).eq('id', t.dataset.invstatus).select('id')
        .then(function (r) { done(r, 'Status updated.'); });
    }
  });

  /* --------------------------------------------------------------- wiring */
  window.wbaLoadPortal = function () {
    if (window.wbaPortalLoaded) return;
    window.wbaPortalLoaded = true;
    loadClients();
    el('ptaClient').addEventListener('change', function () { loadClient(this.value); });
    el('ptaInvite').addEventListener('click', invite);
    el('ptaAddProject').addEventListener('click', addProject);
    el('ptaAddUpdate').addEventListener('click', addUpdate);
    el('ptaAddInvoice').addEventListener('click', addInvoice);
    el('ptaAddPayment').addEventListener('click', addPayment);
    el('ptaAddAccount').addEventListener('click', addAccount);
  };
})();
