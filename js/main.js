/* ==========================================================================
   WBA — shared site behaviour. Loaded on every page.

   Contents
     1  Scroll reveal (fails safe — content is never left hidden)
     2  Mobile nav
     3  FAQ accordion
     4  Forms (email + database, either landing counts as success)
     5  Feed: search, pillar filter
     6  Article widgets: helpful vote, suggest/report/copy
     7  Page polish: skip link, lazy images, WhatsApp button
     8  Hero depth: pointer light + parallax
     9  View transitions: card-to-hero morph
   ========================================================================== */

/* ==========================================================================
   1  SCROLL REVEAL
   Sections start faded. If IntersectionObserver never fires — old browser,
   a screenshot tool, print, a JS error above this line — the content must
   still appear, so visibility is guaranteed and the animation is a bonus.
   ========================================================================== */
(function(){
  function revealAll(){
    document.querySelectorAll('.reveal:not(.in)').forEach(function(el){ el.classList.add('in'); });
  }
  if(!('IntersectionObserver' in window)){ revealAll(); return; }

  var io = new IntersectionObserver(function(entries){
    entries.forEach(function(e){ if(e.isIntersecting){ e.target.classList.add('in'); io.unobserve(e.target); } });
  }, { threshold: 0.06, rootMargin: '0px 0px -40px 0px' });

  document.querySelectorAll('.reveal').forEach(function(el){ io.observe(el); });

  setTimeout(revealAll, 2500);              /* failsafe */
  window.addEventListener('beforeprint', revealAll);
})();

/* ==========================================================================
   2  MOBILE NAV
   ========================================================================== */
function toggleNav(){
  var links = document.getElementById('navLinks');
  var btn = document.querySelector('.nav-toggle');
  if(!links) return;
  var open = links.classList.toggle('open');
  if(btn){ btn.classList.toggle('open', open); btn.setAttribute('aria-expanded', open ? 'true' : 'false'); }
}

/* ==========================================================================
   3  FAQ ACCORDION
   ========================================================================== */
function toggleFaq(btn){
  var item = btn.closest('.faq-item');
  if(!item) return;
  var open = item.classList.contains('open');
  item.classList.toggle('open');
  btn.setAttribute('aria-expanded', open ? 'false' : 'true');
  var a = item.querySelector('.faq-a');
  if(a) a.style.maxHeight = open ? null : a.scrollHeight + 'px';
}

/* ==========================================================================
   4  FORMS
   Every enquiry goes TWO places: the email service (so we get a nudge) and
   our own database (so the lead survives if the email service is down or
   over quota). The submission counts as successful if either one lands.
   ========================================================================== */
var WBA_FORM_ENDPOINT = 'https://formspree.io/f/mvzdgzka';
var WBA_SB = 'https://lynzhiyvggqyplssrapi.supabase.co';
var WBA_SB_KEY = 'sb_publishable_j_RkzVTMyM-QtmFnLsf_Vw_ulanlx9K';

function wbaSaveLead(payload){
  var summary = Object.keys(payload)
    .filter(function(k){ return k.charAt(0) !== '_' && payload[k]; })
    .map(function(k){ return k + ': ' + payload[k]; }).join('\n');
  return fetch(WBA_SB + '/rest/v1/submissions', {
    method: 'POST',
    headers: {
      apikey: WBA_SB_KEY, Authorization: 'Bearer ' + WBA_SB_KEY,
      'Content-Type': 'application/json', Prefer: 'return=minimal'
    },
    body: JSON.stringify({
      type: 'enquiry',
      title: payload.business || payload.name || 'Website enquiry',
      description: summary,
      submitter_name: payload.name || '',
      submitter_email: payload.email || payload.contact || '',
      location: location.pathname
    })
  });
}

async function postForm(payload){
  var emailed = fetch(WBA_FORM_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(payload)
  }).then(function(r){ return r.ok; }).catch(function(){ return false; });

  var stored = wbaSaveLead(payload).then(function(r){ return r.ok; }).catch(function(){ return false; });

  var results = await Promise.all([emailed, stored]);
  return { ok: results[0] || results[1], emailed: results[0], stored: results[1] };
}

function wbaLeadCaptured(which){
  try{ if(typeof wbaTrack === 'function') wbaTrack('form_submit', which); }catch(e){}
}

function showModal(){ var m = document.getElementById('modal'); if(m) m.classList.add('show'); }
function closeModal(){ var m = document.getElementById('modal'); if(m) m.classList.remove('show'); }

/* ---- Confetti ----
   Fired once, from the button, when a submission genuinely lands. Pure DOM —
   no library, no canvas. Skipped entirely for reduced-motion users. */
function wbaConfetti(origin){
  if(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  var colours = ['#ff5f6d', '#ffc371', '#7ee787', '#4facfe', '#b06ab3', '#f5c416', '#ffffff'];
  var rect = origin ? origin.getBoundingClientRect() : { left: innerWidth / 2, top: innerHeight / 2, width: 0, height: 0 };
  var x0 = rect.left + rect.width / 2;
  var y0 = rect.top + rect.height / 2;

  for(var i = 0; i < 70; i++){
    (function(){
      var p = document.createElement('div');
      p.className = 'confetti-piece';
      p.style.background = colours[Math.floor(Math.random() * colours.length)];
      p.style.width = (6 + Math.random() * 6) + 'px';
      p.style.height = (9 + Math.random() * 8) + 'px';
      document.body.appendChild(p);

      /* Safety net: requestAnimationFrame is paused in a background tab, so
         the animation loop alone can't be trusted to clean up after itself. */
      var cull = setTimeout(function(){ p.remove(); }, 4000);

      /* Launch upward and outward, then let gravity take it. */
      var angle = (-Math.PI / 2) + (Math.random() - 0.5) * 2.1;
      var speed = 9 + Math.random() * 11;
      var vx = Math.cos(angle) * speed;
      var vy = Math.sin(angle) * speed;
      var x = x0, y = y0;
      var spin = (Math.random() - 0.5) * 26;
      var rot = Math.random() * 360;
      var life = 0;

      (function step(){
        life++;
        vy += 0.42;             /* gravity */
        vx *= 0.99;             /* drag */
        x += vx; y += vy; rot += spin;
        p.style.transform = 'translate(' + x + 'px,' + y + 'px) rotate(' + rot + 'deg)';
        p.style.opacity = life > 55 ? String(Math.max(0, 1 - (life - 55) / 30)) : '1';
        /* Cull on age, and on falling out of frame — but only once it has had
           a few frames to travel, or a button below the fold spawns confetti
           that deletes itself before the first paint. */
        if(life < 90 && (life < 8 || y < innerHeight + 80)) requestAnimationFrame(step);
        else { clearTimeout(cull); p.remove(); }
      })();
    })();
  }
}

/* Home "Let's talk" form. */
async function wbaSubmitTalk(ev){
  if(ev) ev.preventDefault();

  var s = document.getElementById('tStatus');
  var btn = document.getElementById('tSend');
  function val(id){ var el = document.getElementById(id); return el ? el.value.trim() : ''; }

  var name = val('tName'), contact = val('tContact');
  var company = val('tCompany'), note = val('tNote');
  var optInEl = document.getElementById('tOptIn');
  var optIn = !!(optInEl && optInEl.checked);

  if(!name || !contact){
    if(s){ s.className = 'send-status err'; s.textContent = 'We need a name and a way to reach you.'; }
    return false;
  }

  if(s){ s.className = 'send-status'; s.textContent = 'Sending…'; }
  if(btn) btn.disabled = true;

  try{
    var r = await postForm({
      name: name,
      business: company || 'Not given',
      contact: contact,
      message: note || 'No detail given',
      mailing_list: optIn ? 'yes' : 'no',
      _subject: 'Enquiry — ' + (company || name)
    });
    if(!r.ok) throw new Error('send failed');

    wbaLeadCaptured('home-talk');

    if(btn){
      btn.classList.add('celebrate');
      btn.textContent = "You're in \u{1F389}";
      wbaConfetti(btn);
    }
    if(s){ s.className = 'send-status ok'; s.textContent = "Got it — we'll be in touch asap."; }

    ['tName','tCompany','tContact','tNote'].forEach(function(id){ var el = document.getElementById(id); if(el) el.value = ''; });
    if(optInEl) optInEl.checked = false;

    setTimeout(function(){
      if(!btn) return;
      btn.classList.remove('celebrate');
      btn.textContent = 'Send';
      btn.disabled = false;
    }, 4000);
  }catch(e){
    if(btn) btn.disabled = false;
    if(s){ s.className = 'send-status err'; s.textContent = 'Something went wrong — WhatsApp us on 07902 376369.'; }
  }
  return false;
}

/* Full form — used on the contact page. */
async function submitForm(){
  var s = document.getElementById('sendStatus');
  function val(id){ var el = document.getElementById(id); return el ? el.value.trim() : ''; }
  var name = val('fname'), biz = val('fbiz'), email = val('femail'), msg = val('fmsg');
  var interest = val('finterest');

  if(!name || !email){
    s.className = 'send-status err';
    s.textContent = 'Please add your name and email.';
    return;
  }
  s.className = 'send-status'; s.textContent = 'Sending…';
  try{
    var r = await postForm({
      name: name, business: biz || 'Not given', email: email,
      interest: interest || 'Not specified', message: msg || 'No message',
      _subject: 'Enquiry — ' + (biz || name)
    });
    if(!r.ok) throw new Error('send failed');
    wbaLeadCaptured('contact-form');
    ['fname','fbiz','femail','fmsg'].forEach(function(id){ var el = document.getElementById(id); if(el) el.value = ''; });
    var sel = document.getElementById('finterest'); if(sel) sel.selectedIndex = 0;
    s.textContent = '';
    showModal();
  }catch(e){
    s.className = 'send-status err';
    s.textContent = 'Something went wrong — please WhatsApp us on 07902 376369.';
  }
}

/* ==========================================================================
   5  FEED — predictive search + pillar filter
   Both operate on the cards already in the DOM, so the page works with
   JavaScript off: you just get the full, unfiltered list.
   ========================================================================== */
(function(){
  var grid = document.getElementById('feedGrid');
  if(!grid) return;

  var input = document.getElementById('feedSearch');
  var drop = document.getElementById('searchDrop');
  var dataEl = document.getElementById('feedIndexData');
  var posts = [];
  try{ posts = JSON.parse((dataEl || {}).textContent || '[]'); }catch(e){}

  var cards = {};
  grid.querySelectorAll('.post-card[data-slug]').forEach(function(c){ cards[c.getAttribute('data-slug')] = c; });

  var emptyEl = document.getElementById('feedEmpty');
  var activePillar = 'all';

  function esc(s){ var d = document.createElement('div'); d.textContent = (s == null ? '' : s); return d.innerHTML; }

  function score(p, q){
    var s = 0;
    if(String(p.title || '').toLowerCase().indexOf(q) > -1) s += 3;
    (p.tags || []).forEach(function(t){ if(String(t).toLowerCase().indexOf(q) > -1) s += 2; });
    if(String(p.pillar || '').toLowerCase().indexOf(q) > -1) s += 2;
    if(String(p.excerpt || '').toLowerCase().indexOf(q) > -1) s += 1;
    return s;
  }

  function apply(){
    var q = input ? input.value.trim().toLowerCase() : '';
    var shown = 0;

    posts.forEach(function(p){
      var card = cards[p.slug];
      if(!card) return;
      var pillarOk = activePillar === 'all' || String(p.pillar || '').toLowerCase() === activePillar;
      var searchOk = !q || score(p, q) > 0;
      var visible = pillarOk && searchOk;
      card.style.display = visible ? '' : 'none';
      if(visible) shown++;
    });

    if(emptyEl) emptyEl.style.display = shown ? 'none' : '';

    if(drop){
      if(!q){ drop.style.display = 'none'; return; }
      var ranked = posts
        .filter(function(p){ return activePillar === 'all' || String(p.pillar || '').toLowerCase() === activePillar; })
        .map(function(p){ return { p: p, s: score(p, q) }; })
        .filter(function(r){ return r.s > 0; })
        .sort(function(a, b){ return b.s - a.s; });
      drop.innerHTML = ranked.slice(0, 5).map(function(r){
        return '<a href="/feed/' + encodeURIComponent(r.p.slug) + '/"><b>' + esc(r.p.title) + '</b>' +
               '<span>' + esc(r.p.pillar || 'post') + '</span></a>';
      }).join('') || '<div class="sd-none">No matches — try another word.</div>';
      drop.style.display = 'block';
    }
  }

  if(input){
    input.addEventListener('input', apply);
    input.addEventListener('keydown', function(e){
      if(e.key === 'Enter'){ e.preventDefault(); var a = drop && drop.querySelector('a'); if(a) location.href = a.href; }
      if(e.key === 'Escape'){ if(drop) drop.style.display = 'none'; input.blur(); }
    });
    document.addEventListener('click', function(e){
      if(drop && !e.target.closest('.feed-search')) drop.style.display = 'none';
    });
  }

  document.querySelectorAll('.feed-filters button[data-pillar]').forEach(function(b){
    b.addEventListener('click', function(){
      activePillar = b.getAttribute('data-pillar');
      document.querySelectorAll('.feed-filters button').forEach(function(x){ x.classList.toggle('on', x === b); });
      apply();
    });
  });

  /* Deep link: /feed/?pillar=build */
  var wanted = new URLSearchParams(location.search).get('pillar');
  if(wanted){
    var btn = document.querySelector('.feed-filters button[data-pillar="' + wanted.toLowerCase() + '"]');
    if(btn) btn.click();
  }

  /* Arriving from an elsewhere-on-the-site "Search the Feed" button:
     /feed/#feedSearch should land with the cursor already in the box. */
  if(input && location.hash === '#feedSearch'){
    setTimeout(function(){
      input.focus({ preventScroll: true });
      input.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }, 120);
  }
})();

/* ==========================================================================
   6  ARTICLE WIDGETS — helpful vote, suggest an update, report, copy link
   ========================================================================== */
(function(){
  var w = document.querySelector('.helpful');
  if(!w) return;

  var H = { apikey: WBA_SB_KEY, Authorization: 'Bearer ' + WBA_SB_KEY, 'Content-Type': 'application/json' };
  var slug = w.getAttribute('data-slug');
  var title = w.getAttribute('data-title') || document.title;
  var countEl = w.querySelector('.helpful-count');
  var btnsEl = w.querySelector('.helpful-btns');
  var thanksEl = w.querySelector('.helpful-thanks');

  function showCount(){
    fetch(WBA_SB + '/rest/v1/posts?slug=eq.' + encodeURIComponent(slug) + '&select=helpful_yes', { headers: H })
      .then(function(r){ return r.json(); })
      .then(function(d){
        var y = (d && d[0]) ? (d[0].helpful_yes || 0) : 0;
        if(y > 0 && countEl) countEl.textContent = y + ' reader' + (y === 1 ? '' : 's') + ' found this helpful';
      }).catch(function(){});
  }
  showCount();

  var formEl = document.getElementById('actForm');
  var labelEl = document.getElementById('actLabel');
  var msgEl = document.getElementById('actMsg');
  var actKind = 'article_update';

  function openForm(kind, label, placeholder){
    actKind = kind;
    if(labelEl) labelEl.textContent = label;
    if(msgEl){ msgEl.placeholder = placeholder; }
    if(formEl) formEl.hidden = false;
    if(msgEl) msgEl.focus();
  }

  if(localStorage.getItem('wba_voted_' + slug)){
    if(btnsEl) btnsEl.style.display = 'none';
    if(thanksEl) thanksEl.hidden = false;
  }

  w.querySelectorAll('button[data-vote]').forEach(function(b){
    b.addEventListener('click', function(){
      var up = b.getAttribute('data-vote') === 'yes';
      try{ localStorage.setItem('wba_voted_' + slug, up ? 'yes' : 'no'); }catch(e){}
      if(btnsEl) btnsEl.style.display = 'none';
      if(thanksEl) thanksEl.hidden = false;
      fetch(WBA_SB + '/rest/v1/rpc/vote_helpful', { method: 'POST', headers: H, body: JSON.stringify({ post_slug: slug, up: up }) })
        .then(function(){ setTimeout(showCount, 500); }).catch(function(){});
      if(!up) openForm('article_update', 'Sorry to hear it — what would make this better?', 'What was missing, unclear or out of date?');
    });
  });

  document.querySelectorAll('.article-actions button[data-act]').forEach(function(b){
    b.addEventListener('click', function(){
      var act = b.getAttribute('data-act');
      if(act === 'copy'){
        var label = b.textContent;
        var done = function(){ b.textContent = 'Link copied'; setTimeout(function(){ b.textContent = label; }, 1500); };
        if(navigator.clipboard) navigator.clipboard.writeText(location.href).then(done).catch(done); else done();
        return;
      }
      if(act === 'update') openForm('article_update', 'Suggest an update', 'Spotted something out of date, or know something we should add?');
      if(act === 'report') openForm('article_report', 'Report an issue', "What's wrong — a broken link, an error, something else?");
    });
  });

  var sendBtn = document.getElementById('actSend');
  if(sendBtn) sendBtn.addEventListener('click', function(){
    var s = document.getElementById('actStatus');
    var msg = msgEl ? msgEl.value.trim() : '';
    if(!msg){ s.className = 'send-status err'; s.textContent = 'Add a note first.'; return; }
    s.className = 'send-status'; s.textContent = 'Sending…';
    var nameEl = document.getElementById('actName');
    fetch(WBA_SB + '/rest/v1/submissions', {
      method: 'POST', headers: Object.assign({ Prefer: 'return=minimal' }, H),
      body: JSON.stringify({
        type: actKind, title: title, description: msg,
        location: location.pathname, submitter_name: nameEl ? nameEl.value.trim() : ''
      })
    })
      .then(function(r){
        if(!r.ok) throw new Error('http ' + r.status);
        formEl.innerHTML = '<p class="act-form-label">Received — a real person will read it. Thanks for making this better.</p>';
      })
      .catch(function(){ s.className = 'send-status err'; s.textContent = 'Something went wrong — WhatsApp us instead: 07902 376369.'; });
  });
})();

/* ==========================================================================
   7  PAGE POLISH
   ========================================================================== */
(function(){
  var active = document.querySelector('.nav-links a.active');
  if(active) active.setAttribute('aria-current', 'page');

  var main = document.querySelector('.hero, .page-hero, main');
  if(main){
    if(!main.id) main.id = 'main';
    var skip = document.createElement('a');
    skip.href = '#main';
    skip.className = 'skip-link';
    skip.textContent = 'Skip to content';
    document.body.insertBefore(skip, document.body.firstChild);
  }

  document.querySelectorAll('img').forEach(function(img){
    img.decoding = 'async';
    if(!img.closest('.nav') && !img.closest('.hero')) img.loading = 'lazy';
  });

  var fab = document.createElement('a');
  fab.href = 'https://wa.me/447902376369';
  fab.target = '_blank';
  fab.rel = 'noopener';
  fab.className = 'wa-fab';
  fab.setAttribute('aria-label', 'Message us on WhatsApp');
  fab.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.45 1.32 4.95L2 22l5.25-1.38c1.45.79 3.08 1.2 4.79 1.2h.01c5.46 0 9.91-4.45 9.91-9.91C21.96 6.45 17.5 2 12.04 2zm5.8 14.18c-.25.69-1.45 1.32-1.99 1.36-.53.05-1.02.24-3.45-.72-2.91-1.15-4.76-4.12-4.9-4.31-.14-.19-1.17-1.56-1.17-2.97 0-1.41.74-2.11 1-2.4.26-.29.57-.36.76-.36.19 0 .38 0 .55.01.18.01.42-.07.65.5.25.6.84 2.07.91 2.22.07.14.12.31.02.5-.09.19-.14.31-.28.48-.14.17-.29.38-.42.5-.14.14-.28.29-.12.57.16.28.71 1.17 1.53 1.9 1.05.94 1.94 1.23 2.22 1.37.28.14.44.12.6-.07.16-.19.69-.81.87-1.08.18-.28.36-.23.61-.14.25.09 1.6.76 1.87.9.28.14.46.21.53.33.07.12.07.66-.18 1.35z"/></svg><span class="wa-label">WhatsApp</span>';
  document.body.appendChild(fab);

  /* Hold it back until the hero is out of the way.

     A floating button sits on top of whatever scrolls under it. At the top of
     a phone screen that is the hero's own buttons — measured, it was covering
     "Learn More" — and a shortcut that hides the primary call to action is a
     bad trade. Below the fold it only ever overlaps a corner of a card, which
     is what a floating action button is understood to do. */
  var showAfter = function(){
    var hero = document.querySelector('.hero, .page-hero');
    var past = hero
      ? window.scrollY > hero.getBoundingClientRect().height * 0.75
      : window.scrollY > window.innerHeight * 0.6;
    fab.classList.toggle('is-in', past);
  };
  showAfter();
  window.addEventListener('scroll', showAfter, { passive: true });
})();

/* ==========================================================================
   8  HERO DEPTH — pointer light and parallax

   Two effects, one listener, no layout reads after the first frame.

     --px / --py   where the pointer is, as a percentage of the hero. The
                   scrim's ::after paints a soft radial light there, so the
                   photograph appears to be lit by the cursor.
     --mx / --my   the same position remapped to -1..1. CSS multiplies it by
                   a handful of pixels and translates the photograph against
                   the pointer while the panels on top stay put, which is
                   what reads as depth.

   Why it is written this way:

   - getBoundingClientRect() is called on pointerenter and on resize, never
     on pointermove. Reading layout during a move handler is the classic way
     to turn a smooth effect into a stuttering one.
   - Writes are batched into one requestAnimationFrame callback. Several
     pointermove events can fire between frames; only the last one matters.
   - Custom properties are set on the hero, not on the moving layers, so the
     browser only has to recompute a transform — no style recalc cascade.
   - Touch devices never get it. A finger is not a hover, and firing this on
     tap would make the photo jump.
   ========================================================================== */
(function(){
  var hero = document.querySelector('.hero, .page-hero');
  if (!hero) return;

  /* Coarse pointer means touch. Reduced motion means the user asked for
     none of this. Either way, leave the defaults in the stylesheet alone. */
  if (!window.matchMedia) return;
  if (window.matchMedia('(pointer: coarse)').matches) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  var box = null, frame = 0, px = 22, py = 32, mx = 0, my = 0;

  function measure(){ box = hero.getBoundingClientRect(); }

  function paint(){
    frame = 0;
    hero.style.setProperty('--px', px.toFixed(2) + '%');
    hero.style.setProperty('--py', py.toFixed(2) + '%');
    hero.style.setProperty('--mx', mx.toFixed(3));
    hero.style.setProperty('--my', my.toFixed(3));
  }

  hero.addEventListener('pointerenter', function(){
    measure();
    hero.style.setProperty('--torch', '1');
  });

  hero.addEventListener('pointermove', function(e){
    if (!box) measure();
    var x = (e.clientX - box.left) / box.width;
    var y = (e.clientY - box.top) / box.height;
    px = x * 100; py = y * 100;
    mx = x * 2 - 1; my = y * 2 - 1;
    if (!frame) frame = requestAnimationFrame(paint);
  }, { passive: true });

  hero.addEventListener('pointerleave', function(){
    hero.style.setProperty('--torch', '0');
    /* Ease the parallax back to centre rather than snapping it. The CSS has
       no transition on transform (it would fight the pointer), so the return
       is done here over a few frames. */
    var sx = mx, sy = my, t0 = performance.now();
    (function ease(now){
      var k = Math.min(1, (now - t0) / 420);
      var e2 = 1 - Math.pow(1 - k, 3);
      mx = sx * (1 - e2); my = sy * (1 - e2);
      paint();
      if (k < 1) requestAnimationFrame(ease);
    })(t0);
  });

  window.addEventListener('resize', function(){ box = null; }, { passive: true });
  window.addEventListener('scroll', function(){ box = null; }, { passive: true });
})();

/* ==========================================================================
   9  VIEW TRANSITIONS — the two things CSS cannot know

   The transition itself is pure CSS: @view-transition in the stylesheet, and
   three named elements. Nothing here is required for it to work. What this
   adds is the part that depends on WHERE you are going, which a stylesheet
   has no way to ask about.

   1. Tidy the outgoing page.
      If the mobile menu is open when you tap a link, the old snapshot has an
      open menu and the new one does not, so the browser dutifully animates a
      menu closing during a page change. Close it before the snapshot.

   2. Expand the card you clicked into the article you opened.
      This is the one worth having. A Feed card and an article hero are the
      same photograph at two sizes, so if both carry the same
      view-transition-name the browser tweens one into the other: the card
      grows out of the grid and becomes the top of the article.

      The mechanics, because they are easy to get wrong:

      · Only ONE element per document may hold a given name. The Feed index
        already puts `wba-hero-photo` on its own hero photograph, so that has
        to be released before the card can take it — two elements sharing a
        name makes the browser skip the whole transition, silently.

      · The name goes on at `pageswap` time, which fires after the click and
        before the snapshot. Naming every card upfront would be wrong: the
        browser would try to match fifteen cards against one hero.

      · Names are removed again once the transition finishes, so a page
        restored from the back/forward cache does not come back holding a
        name that no longer means anything.

   `pagereveal` — the incoming half — is deliberately not used. It has to be
   registered in a parser-blocking script in the <head> to be reliable, and
   this file is deferred. Forward navigation gets the morph; going back gets
   the standard crossfade, which is correct anyway: you are returning to a
   grid, not opening one thing.
   ========================================================================== */
(function(){
  if (!('onpageswap' in window)) return;

  var NAME = 'wba-hero-photo';

  function tidyNav(){
    var links = document.getElementById('navLinks');
    var btn = document.querySelector('.nav-toggle');
    if (links) links.classList.remove('open');
    if (btn) { btn.classList.remove('open'); btn.setAttribute('aria-expanded', 'false'); }
  }

  /* The card whose href is where we are going, if there is one. */
  function cardFor(url){
    var path;
    try { path = new URL(url, location.href).pathname; } catch (e) { return null; }
    var cards = document.querySelectorAll('.post-card[href], .work-card[href]');
    for (var i = 0; i < cards.length; i++) {
      var href = cards[i].getAttribute('href');
      try {
        if (new URL(href, location.href).pathname === path) return cards[i];
      } catch (e) { /* skip a malformed href rather than failing the click */ }
    }
    return null;
  }

  window.addEventListener('pageswap', function(e){
    tidyNav();
    if (!e.viewTransition || !e.activation || !e.activation.entry) return;

    var card = cardFor(e.activation.entry.url);
    if (!card) return;

    /* Prefer the card's photograph — matching photo to photo is what makes
       the morph read as the same object rather than a box turning into a
       picture. Fall back to the card itself when it has no image. */
    var from = card.querySelector('.post-card-media, img') || card;
    var hero = document.querySelector('.hero-media');

    if (hero) hero.style.viewTransitionName = 'none';
    from.style.viewTransitionName = NAME;

    e.viewTransition.finished.then(function(){
      from.style.viewTransitionName = '';
      if (hero) hero.style.viewTransitionName = '';
    });
  });
})();
