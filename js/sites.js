/* ==========================================================================
   WBA — /sites/ interactions.

   1. The perk rail. Four are on screen at a time. Every few seconds the top
      one slides out to the right, the remaining three lift up to fill the
      gap, and the next one arrives from underneath — a stacked shuffle
      rather than a marquee.

      Done by moving the node to the end of the list, so the DOM order stays
      honest and nothing is cloned. The lift is a FLIP: measure where the rows
      are, re-order, then animate from the old position to the new one. That
      is what makes the remaining rows glide instead of jumping.

   2. The pressable button — a short scale-down plus a ring, so a click feels
      answered the way it would in a native app.
   ========================================================================== */
(function () {
  'use strict';

  var reduced = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------------------------------------------------- next working day - */
  (function () {
    var dateEl = document.getElementById('tbDate');
    if (!dateEl) return;
    /* Worked out in the browser so it can never go stale. Friday rolls to
       Monday; a date printed into the HTML would be wrong by tomorrow. */
    var d = new Date();
    d.setDate(d.getDate() + 1);
    while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);

    var days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    dateEl.textContent = days[d.getDay()] + ' ' + d.getDate() + ' ' + months[d.getMonth()];
    dateEl.setAttribute('datetime', d.toISOString().slice(0, 10));
  })();

  /* --------------------------------------------- the questions thread ---- */
  (function () {
    var thread = document.getElementById('talkThread');
    if (!thread || reduced) return;
    var list = thread.querySelector('.tt-list');
    if (!list || list.children.length < 3) return;

    var DELAY = 2600, timer = null, visible = true;

    function shuffle() {
      var first = list.firstElementChild;
      if (!first) return;
      first.classList.add('is-out');
      setTimeout(function () {
        list.appendChild(first);
        first.classList.remove('is-out');
        first.classList.add('is-in');
        requestAnimationFrame(function () {
          requestAnimationFrame(function () { first.classList.remove('is-in'); });
        });
      }, 420);
    }

    function start() { if (!timer && visible) timer = setInterval(shuffle, DELAY); }
    function stop() { clearInterval(timer); timer = null; }

    document.addEventListener('visibilitychange', function () {
      if (document.hidden) stop(); else start();
    });
    if (window.IntersectionObserver) {
      new IntersectionObserver(function (e) {
        visible = e[0].isIntersecting;
        if (visible) start(); else stop();
      }, { threshold: 0.2 }).observe(thread);
    } else { start(); }
  })();

  /* ------------------------------------------------------- the perk rail - */
  (function () {
    var rail = document.getElementById('perkRail');
    if (!rail) return;
    var list = rail.querySelector('.pk-list');
    if (!list || list.children.length < 5) return;   // nothing to cycle
    if (reduced) return;                             // leave it as a plain list

    var DELAY = 2800, timer = null, visible = true, busy = false;

    function shuffle() {
      if (busy) return;
      var rows = [].slice.call(list.children);
      var first = rows[0];
      busy = true;

      /* FLIP: remember where every row starts. */
      var before = rows.map(function (el) { return el.getBoundingClientRect().top; });

      first.classList.add('is-out');

      setTimeout(function () {
        list.appendChild(first);                 // move, do not clone
        first.classList.remove('is-out');
        first.classList.add('is-in');

        var after = rows.map(function (el) { return el.getBoundingClientRect().top; });

        rows.forEach(function (el, i) {
          if (el === first) return;
          var delta = before[i] - after[i];
          if (!delta) return;
          el.style.transition = 'none';
          el.style.transform = 'translateY(' + delta + 'px)';
        });

        requestAnimationFrame(function () {
          rows.forEach(function (el) {
            if (el === first) return;
            el.style.transition = '';
            el.style.transform = '';
          });
          requestAnimationFrame(function () { first.classList.remove('is-in'); });
        });

        setTimeout(function () { busy = false; }, 600);
      }, 480);
    }

    function start() { if (!timer && visible) timer = setInterval(shuffle, DELAY); }
    function stop() { clearInterval(timer); timer = null; }

    /* Hold still while it is being read or edited. */
    rail.addEventListener('pointerenter', stop);
    rail.addEventListener('pointerleave', start);
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) stop(); else start();
    });

    if (window.MutationObserver) {
      new MutationObserver(function () {
        if (document.body.classList.contains('wba-editing')) stop(); else start();
      }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
    }

    if (window.IntersectionObserver) {
      new IntersectionObserver(function (e) {
        visible = e[0].isIntersecting;
        if (visible) start(); else stop();
      }, { threshold: 0.25 }).observe(rail);
    } else {
      start();
    }
  })();

  /* --------------------------------------------------- pressable buttons - */
  document.addEventListener('pointerdown', function (e) {
    var b = e.target.closest && e.target.closest('.btn.press');
    if (!b) return;
    b.classList.remove('is-pressed');
    /* Force a reflow so the animation can be retriggered on a rapid second click. */
    void b.offsetWidth;
    b.classList.add('is-pressed');
    setTimeout(function () { b.classList.remove('is-pressed'); }, 520);
  });
})();
