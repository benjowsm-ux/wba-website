/* ==========================================================================
   WBA — hero stage.

   The review tab is the only interactive piece, as designed:
     * drag it anywhere inside the hero (pointer capture, clamped to the stage)
     * arrows fade in when you come near it and fade out when you leave
     * clicking one wipes white across the card and swaps to the next pairing —
       review AND the work image behind it move together
     * the stars glide from empty to the rating rather than snapping
     * the tab sits semi-transparent, brightens on approach, and settles back
       a few seconds after you stop touching it

   The reviews are read from the .ws-shot figures rather than kept in a
   separate array, so there is one copy of the words: the one edit mode edits.
   ========================================================================== */
(function () {
  'use strict';

  var stage = document.getElementById('heroStage');
  var tab   = document.getElementById('rvTab');
  if (!stage || !tab) return;

  var shots = [].slice.call(stage.querySelectorAll('.ws-shot'));
  if (!shots.length) return;

  var elQuote = document.getElementById('rvQuote');
  var elWho   = document.getElementById('rvWho');
  var elFill  = document.getElementById('rvStarsFill');
  var prev    = document.getElementById('rvPrev');
  var next    = document.getElementById('rvNext');

  var reduced = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  var index = 0, busy = false;

  function editing() { return document.body.classList.contains('wba-editing'); }

  function dataFor(i) {
    var f = shots[i];
    var q = f.querySelector('.ws-quote');
    var n = f.querySelector('figcaption');
    var r = parseFloat(f.getAttribute('data-rating'));
    return {
      quote: q ? q.textContent.trim() : '',
      who:   n ? n.textContent.trim() : '',
      rating: isFinite(r) ? Math.max(0, Math.min(5, r)) : 5
    };
  }

  function paint(i) {
    var d = dataFor(i);
    elQuote.textContent = d.quote;
    elWho.textContent = d.who;
    /* Width drives the fill, so the stars glide across rather than pop. */
    elFill.style.width = (d.rating / 5 * 100) + '%';
    shots.forEach(function (f, n) {
      f.classList.toggle('is-active', n === i);
      f.toggleAttribute('aria-hidden', n !== i);
    });
  }

  function go(dir) {
    if (busy || shots.length < 2) return;
    var target = (index + dir + shots.length) % shots.length;

    if (reduced) { index = target; paint(index); return; }

    busy = true;
    tab.classList.add('is-swapping', dir > 0 ? 'wipe-next' : 'wipe-prev');

    /* Swap under the cover of the wipe, at the moment it fills the card. */
    setTimeout(function () {
      index = target;
      paint(index);
    }, 300);

    setTimeout(function () {
      tab.classList.remove('is-swapping', 'wipe-next', 'wipe-prev');
      busy = false;
    }, 640);
  }

  prev && prev.addEventListener('click', function (e) { e.stopPropagation(); go(-1); });
  next && next.addEventListener('click', function (e) { e.stopPropagation(); go(1); });

  /* ---------------------------------------------------------- awake state - */
  var sleepTimer = null;
  function wake() {
    tab.classList.add('is-awake');
    clearTimeout(sleepTimer);
    sleepTimer = setTimeout(function () {
      if (!dragging) tab.classList.remove('is-awake');
    }, 2600);
  }
  ['pointerenter', 'pointermove', 'focusin'].forEach(function (ev) {
    tab.addEventListener(ev, wake);
  });
  tab.addEventListener('pointerleave', function () {
    clearTimeout(sleepTimer);
    sleepTimer = setTimeout(function () {
      if (!dragging) tab.classList.remove('is-awake');
    }, 700);
  });

  /* ------------------------------------------------------------- dragging - *
     The old version was jittery for a specific reason: it called
     getBoundingClientRect() on every pointermove to work out the clamp, then
     wrote a transform. Reading layout and writing style in the same frame
     forces a synchronous re-layout each move — the browser cannot batch, and
     the card stutters against the pointer.

     The fix is the standard one: measure ONCE on pointerdown, then during the
     move only store the coordinates and let a single requestAnimationFrame
     write the transform. No layout is read while dragging.

     The whole window is not the handle — the title bar is, exactly as a real
     window behaves. That also leaves the arrows and the text clickable.       */
  var dragging = false, startX = 0, startY = 0, ox = 0, oy = 0, dx = 0, dy = 0;
  var minX = 0, maxX = 0, minY = 0, maxY = 0, frame = null;
  var grip = document.getElementById('rvGrip') || tab;

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  function paintDrag() {
    frame = null;
    tab.style.transform = 'translate3d(' + dx + 'px,' + dy + 'px,0)';
  }

  grip.addEventListener('pointerdown', function (e) {
    if (editing()) return;
    if (e.target.closest('.rv-arrow')) return;
    if (e.button !== 0) return;
    if (!matchMedia('(hover: hover) and (pointer: fine)').matches) return;

    /* Measure once. These bounds hold for the whole gesture. */
    var sr = stage.getBoundingClientRect();
    var tr = tab.getBoundingClientRect();
    var restLeft = tr.left - dx, restTop = tr.top - dy;
    minX = sr.left - restLeft;
    maxX = sr.right - tr.width - restLeft;
    minY = sr.top - restTop;
    maxY = sr.bottom - tr.height - restTop;

    dragging = true;
    startX = e.clientX; startY = e.clientY;
    ox = dx; oy = dy;
    tab.classList.add('is-dragging', 'is-lifted');
    tab.style.willChange = 'transform';
    grip.setPointerCapture(e.pointerId);
    wake();
    e.preventDefault();
  });

  grip.addEventListener('pointermove', function (e) {
    if (!dragging) return;
    dx = clamp(ox + (e.clientX - startX), minX, maxX);
    dy = clamp(oy + (e.clientY - startY), minY, maxY);
    /* One write per frame, no reads. */
    if (!frame) frame = requestAnimationFrame(paintDrag);
  });

  function endDrag(e) {
    if (!dragging) return;
    dragging = false;
    if (frame) { cancelAnimationFrame(frame); frame = null; paintDrag(); }
    tab.classList.remove('is-dragging');
    tab.style.willChange = '';
    try { grip.releasePointerCapture(e.pointerId); } catch (err) {}
    wake();
  }
  grip.addEventListener('pointerup', endDrag);
  grip.addEventListener('pointercancel', endDrag);

  /* Double-click returns it home — always a way back. */
  grip.addEventListener('dblclick', function () {
    dx = dy = 0;
    tab.style.transition = 'transform 420ms var(--m-settle)';
    tab.style.transform = '';
    tab.classList.remove('is-lifted');
    setTimeout(function () { tab.style.transition = ''; }, 460);
  });

  /* Keyboard: the tab is a group, so arrow keys move between reviews. */
  tab.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowLeft')  { e.preventDefault(); go(-1); }
    if (e.key === 'ArrowRight') { e.preventDefault(); go(1); }
  });

  /* Edit mode shows every shot stacked so all of them can be edited; put the
     stage back the way it was when editing stops. */
  if (window.MutationObserver) {
    new MutationObserver(function () { if (!editing()) paint(index); })
      .observe(document.body, { attributes: true, attributeFilter: ['class'] });
  }

  paint(0);
  /* Let the stars glide in on first paint rather than starting full. */
  if (!reduced) {
    elFill.style.width = '0%';
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { paint(0); });
    });
  }
})();
