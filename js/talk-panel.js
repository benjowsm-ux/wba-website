/* ==========================================================================
   WBA — the "A message, not a meeting" panel on /sites/.

   Two small jobs:
   1. Show the next working day, worked out in the browser so it is never
      stale. A date printed into the HTML would be wrong by tomorrow.
   2. Cycle the questions: the top one leaves, everything shuffles up, a new
      one arrives at the bottom. It runs on a timer and stops whenever it
      isn't being looked at.
   ========================================================================== */
(function () {
  'use strict';

  /* ---------------------------------------------------- next working day - */
  var dateEl = document.getElementById('tbDate');
  if (dateEl) {
    /* The next working day, always at least tomorrow, skipping the weekend. */
    var d = new Date();
    d.setDate(d.getDate() + 1);
    while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);

    var days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    dateEl.textContent = days[d.getDay()] + ' ' + d.getDate() + ' ' + months[d.getMonth()];
    dateEl.setAttribute('datetime', d.toISOString().slice(0, 10));
  }

  /* --------------------------------------------------------- the thread - */
  var thread = document.getElementById('talkThread');
  if (!thread) return;
  var list = thread.querySelector('.tt-list');
  if (!list || list.children.length < 3) return;

  var reduced = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduced) return;                       // leave the list as a plain list

  var DELAY = 2600, timer = null, visible = true;

  function shuffle() {
    var first = list.firstElementChild;
    if (!first) return;

    /* Fade the top one out, then move it to the bottom and let it fade back
       in. Moving the node keeps the DOM order honest — no clones to leak. */
    first.classList.add('is-out');
    setTimeout(function () {
      list.appendChild(first);
      first.classList.remove('is-out');
      first.classList.add('is-in');
      /* One frame later, drop the class so the transition actually runs. */
      requestAnimationFrame(function () {
        requestAnimationFrame(function () { first.classList.remove('is-in'); });
      });
    }, 420);
  }

  function start() { if (!timer && visible) timer = setInterval(shuffle, DELAY); }
  function stop()  { clearInterval(timer); timer = null; }

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) stop(); else start();
  });

  if (window.IntersectionObserver) {
    new IntersectionObserver(function (entries) {
      visible = entries[0].isIntersecting;
      if (visible) start(); else stop();
    }, { threshold: 0.2 }).observe(thread);
  } else {
    start();
  }
})();
