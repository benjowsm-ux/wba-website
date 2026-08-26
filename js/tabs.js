/* ==========================================================================
   WBA — hero tabs.

   Every .win in a hero that carries data-tab becomes a small window you can
   actually handle:

     data-tab="drag"            grab the title bar, move it anywhere on the hero
     data-tab="drag collapse"   ...and a chevron that folds the body away

   Why this is one file rather than three
   --------------------------------------
   The homepage review card had its own drag code, the sub-page panels had
   none, and the next window would have needed a third copy. They are the same
   object with different contents, so they get one implementation and one set
   of bugs.

   Two decisions worth keeping
   ---------------------------
   1. The boundary is the WHOLE HERO, not the box the window happens to sit
      in. Previously the review card was clamped to a wrapper around itself
      and the photograph, so it could not be dragged up next to the headline —
      which is exactly where someone would try to put it.

   2. Measure once on pointerdown, write once per animation frame. Calling
      getBoundingClientRect() inside pointermove reads layout in the same
      frame as a style write, which forces a synchronous re-layout on every
      single move. That is what made the old one stutter against the pointer.

   Collapse state survives a page change through sessionStorage, so folding a
   panel away does not un-fold itself the moment you click a link.
   ========================================================================== */
(function () {
  'use strict';

  /* Any window that asks for it, wherever it is. Dragging still needs a hero
     to be clamped to and bows out below if there isn't one — but folding is
     useful anywhere, and the build map is a section, not a hero. */
  var tabs = [].slice.call(document.querySelectorAll('[data-tab]'));
  if (!tabs.length) return;

  var FINE = window.matchMedia &&
             matchMedia('(hover: hover) and (pointer: fine)').matches;

  function editing() { return document.body.classList.contains('wba-editing'); }
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  /* Panels differ page to page, so key the memory on the page and the label
     rather than on a position in the document. */
  function keyFor(el) {
    var t = el.querySelector('.win-title');
    return 'wba-tab:' + location.pathname + ':' + (t ? t.textContent.trim() : el.className);
  }
  function remember(el, open) {
    try { sessionStorage.setItem(keyFor(el), open ? '1' : '0'); } catch (e) {}
  }
  function recall(el) {
    try { return sessionStorage.getItem(keyFor(el)); } catch (e) { return null; }
  }

  var CHEV =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';

  tabs.forEach(function (el) {
    var modes = (el.getAttribute('data-tab') || '').split(/\s+/);
    var bar = el.querySelector('.win-bar');
    if (!bar) return;

    /* ------------------------------------------------------------ collapse */
    if (modes.indexOf('collapse') >= 0) {
      var body = el.querySelector('.win-body');
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'win-fold';
      btn.innerHTML = CHEV;
      bar.appendChild(btn);

      /* Closed by default on a phone. A panel of numbers unfolding under the
         headline is the first thing a thumb hits, and on a narrow screen it
         pushes the actual page below the fold. */
      var narrow = window.matchMedia && matchMedia('(max-width: 760px)').matches;
      var saved = recall(el);
      var open = saved === null ? !narrow : saved === '1';

      var setOpen = function (v, animate) {
        open = v;
        el.classList.toggle('is-folded', !v);
        btn.setAttribute('aria-expanded', v ? 'true' : 'false');
        btn.setAttribute('aria-label', v ? 'Collapse this panel' : 'Expand this panel');
        if (body) body.hidden = false;          /* height, not hidden — it animates */
        if (animate) remember(el, v);
      };
      setOpen(open, false);

      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        setOpen(!open, true);
      });
      /* Double-clicking a title bar folds the window — as it does on a Mac. */
      bar.addEventListener('dblclick', function (e) {
        if (e.target.closest('.win-fold')) return;
        setOpen(!open, true);
      });
    }

    /* ---------------------------------------------------------------- drag */
    if (modes.indexOf('drag') < 0 || !FINE) return;

    /* Whatever the window is allowed to roam around in. A hero on the
       marketing pages; the deck on the client portal. Marking the boundary
       with an attribute means the next thing that wants draggable windows
       does not have to touch this file. */
    var hero = el.closest('[data-tab-area], .hero, .page-hero');
    if (!hero) return;

    var dragging = false, moved = false, frame = null;
    var startX = 0, startY = 0, ox = 0, oy = 0, dx = 0, dy = 0;
    var minX = 0, maxX = 0, minY = 0, maxY = 0;

    el.classList.add('is-draggable');

    function paint() {
      frame = null;
      el.style.transform = 'translate3d(' + dx + 'px,' + dy + 'px,0)';
    }

    bar.addEventListener('pointerdown', function (e) {
      if (editing() || e.button !== 0) return;
      if (e.target.closest('button, a, input')) return;

      /* Measured once; these bounds hold for the whole gesture. Reading the
         rest position by subtracting the current offset means a second drag
         continues from where the first one stopped. */
      var hr = hero.getBoundingClientRect();
      var tr = el.getBoundingClientRect();
      var restLeft = tr.left - dx, restTop = tr.top - dy;
      minX = hr.left - restLeft;
      maxX = hr.right - tr.width - restLeft;
      minY = hr.top - restTop;
      maxY = hr.bottom - tr.height - restTop;

      dragging = true; moved = false;
      startX = e.clientX; startY = e.clientY;
      ox = dx; oy = dy;
      el.classList.add('is-dragging', 'is-lifted');
      el.style.willChange = 'transform';
      bar.setPointerCapture(e.pointerId);
      e.preventDefault();
    });

    bar.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      var nx = ox + (e.clientX - startX);
      var ny = oy + (e.clientY - startY);
      if (!moved && Math.abs(nx - ox) + Math.abs(ny - oy) > 3) moved = true;
      dx = clamp(nx, minX, maxX);
      dy = clamp(ny, minY, maxY);
      if (!frame) frame = requestAnimationFrame(paint);   /* one write, no reads */
    });

    function end(e) {
      if (!dragging) return;
      dragging = false;
      if (frame) { cancelAnimationFrame(frame); frame = null; paint(); }
      el.classList.remove('is-dragging');
      el.style.willChange = '';
      try { bar.releasePointerCapture(e.pointerId); } catch (err) {}
    }
    bar.addEventListener('pointerup', end);
    bar.addEventListener('pointercancel', end);

    /* A window dragged into a corner and forgotten is a trap; there is always
       a way home. The fold shortcut owns plain double-click, so this is the
       one with a modifier. */
    bar.addEventListener('dblclick', function (e) {
      if (!e.shiftKey && !e.altKey) return;
      dx = dy = 0;
      el.style.transition = 'transform 420ms var(--m-settle)';
      el.style.transform = '';
      el.classList.remove('is-lifted');
      setTimeout(function () { el.style.transition = ''; }, 460);
    });

    /* The clamp was computed against the old viewport. Rather than recompute
       on every resize, send the window home — its resting spot is always
       correct, wherever the layout ended up. */
    var rt = null;
    window.addEventListener('resize', function () {
      if (!dx && !dy) return;
      clearTimeout(rt);
      rt = setTimeout(function () {
        dx = dy = 0;
        el.style.transform = '';
        el.classList.remove('is-lifted');
      }, 180);
    }, { passive: true });
  });
})();
