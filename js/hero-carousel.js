/* ==========================================================================
   WBA — hero carousel.

   Slides advance on their own every few seconds, the way an idle screen
   cycles promos, and you can throw them along with a pointer or a swipe.

   Deliberate behaviours, because each one is a real annoyance otherwise:
   * autoplay stops the moment you touch, hover or focus it, and does not
     restart until you leave — nothing moves out from under a click;
   * it pauses entirely when the tab is hidden or the hero is scrolled off,
     so a background tab isn't burning a timer;
   * `prefers-reduced-motion` disables autoplay altogether. The dots still
     work, so the content is never unreachable;
   * edit mode owns the page while it is on, so the carousel stands still.
   ========================================================================== */
(function () {
  'use strict';

  var root = document.querySelector('.hero-showcase');
  if (!root) return;

  var track = root.querySelector('.hs-track');
  var slides = [].slice.call(root.querySelectorAll('.hs-slide'));
  var dotsBox = root.querySelector('.hs-dots');
  if (!track || slides.length < 1) return;

  var reduced = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  var delay = Math.max(2500, parseInt(root.getAttribute('data-autoplay'), 10) || 6000);
  var index = 0, timer = null, held = false, visible = true;

  /* ---- dots ---- */
  var dots = [];
  if (dotsBox && slides.length > 1) {
    slides.forEach(function (_, i) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'hs-dot';
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-label', 'Show item ' + (i + 1) + ' of ' + slides.length);
      b.addEventListener('click', function () { go(i); restart(); });
      dotsBox.appendChild(b);
      dots.push(b);
    });
  }

  function go(i) {
    index = (i + slides.length) % slides.length;
    track.style.transform = 'translateX(' + (-index * 100) + '%)';
    slides.forEach(function (s, n) {
      /* Hide the off-screen slides from assistive tech and from tabbing —
         otherwise focus jumps to a link nobody can see. */
      s.toggleAttribute('aria-hidden', n !== index);
      s.querySelectorAll('a,button').forEach(function (el) {
        if (n === index) el.removeAttribute('tabindex');
        else el.setAttribute('tabindex', '-1');
      });
    });
    dots.forEach(function (d, n) {
      d.classList.toggle('on', n === index);
      d.setAttribute('aria-selected', n === index ? 'true' : 'false');
    });
  }

  /* ---- autoplay ---- */
  function editing() { return document.body.classList.contains('wba-editing'); }
  function tick() { if (!held && visible && !editing()) go(index + 1); }
  function start() {
    if (reduced || slides.length < 2 || timer) return;
    timer = setInterval(tick, delay);
  }

  /* Edit mode stacks every slide so they can all be reached; the carousel
     must not slide the track out from under someone mid-sentence. */
  if (window.MutationObserver) {
    new MutationObserver(function () {
      if (editing()) { track.style.transform = ''; }
      else { go(index); }
    }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  }
  function stop() { clearInterval(timer); timer = null; }
  function restart() { stop(); start(); }

  ['pointerenter', 'focusin'].forEach(function (ev) {
    root.addEventListener(ev, function () { held = true; });
  });
  ['pointerleave', 'focusout'].forEach(function (ev) {
    root.addEventListener(ev, function () { held = false; });
  });
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) stop(); else start();
  });

  /* Only run while the hero is actually on screen. */
  if (window.IntersectionObserver) {
    new IntersectionObserver(function (entries) {
      visible = entries[0].isIntersecting;
      if (visible) start(); else stop();
    }, { threshold: 0.15 }).observe(root);
  }

  /* ---- drag / swipe ---- */
  var startX = 0, dx = 0, dragging = false;

  track.addEventListener('pointerdown', function (e) {
    if (document.body.classList.contains('wba-editing')) return;
    if (e.target.closest('a,button,[contenteditable="true"]')) return;
    dragging = true; startX = e.clientX; dx = 0;
    track.classList.add('is-dragging');
    track.setPointerCapture(e.pointerId);
  });

  track.addEventListener('pointermove', function (e) {
    if (!dragging) return;
    dx = e.clientX - startX;
    track.style.transform = 'translateX(calc(' + (-index * 100) + '% + ' + dx + 'px))';
  });

  function release(e) {
    if (!dragging) return;
    dragging = false;
    track.classList.remove('is-dragging');
    try { track.releasePointerCapture(e.pointerId); } catch (err) {}
    /* A quarter of the card's width, or 80px, whichever is smaller — enough
       that a stray nudge doesn't change slide, little enough that a flick does. */
    var threshold = Math.min(80, track.offsetWidth * 0.25);
    if (dx > threshold) go(index - 1);
    else if (dx < -threshold) go(index + 1);
    else go(index);
    restart();
  }
  track.addEventListener('pointerup', release);
  track.addEventListener('pointercancel', release);

  go(0);
  start();
})();
