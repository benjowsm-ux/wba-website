/* ==========================================================================
   WBA — the build map.

   A pannable, zoomable surface holding the stages of a website build as
   connected nodes. Three jobs:

     1. move the world     drag to pan, ctrl/⌘+wheel or the buttons to zoom,
                           two fingers to pinch
     2. draw the wires     bezier paths generated from where the nodes
                           actually are, so a node's coordinates are the only
                           thing anyone has to edit
     3. open a node        the arrow turns, a description unfolds

   Decisions worth keeping
   -----------------------
   · Plain wheel does NOT zoom. A canvas that eats the scroll wheel halfway
     down a long page is the single most hated pattern on the web — you try
     to read on and the page stops moving. Zoom is on ctrl/⌘+wheel (which is
     also what a trackpad pinch sends), on the +/- buttons, and on
     double-click. The hint line says so.

   · Zoom is anchored to the pointer. Scaling about the top-left corner
     throws whatever you were looking at off the screen; the standard fix is
     to solve for the translation that keeps the world point under the cursor
     fixed:  t' = p - (p - t) * (k'/k)

   · One transform, on one element, written from a rAF. Everything inside
     .tt-world is laid out once in world coordinates and never touched again.

   · The grid belongs to the viewport, not the world. Driving its
     background-position and background-size from the same numbers gives an
     infinite grid that stays crisp at any zoom, instead of a giant div that
     eventually runs out and goes blurry.
   ========================================================================== */
(function () {
  'use strict';

  var vp = document.getElementById('ttViewport');
  var world = document.getElementById('ttWorld');
  if (!vp || !world) return;

  var svg = document.getElementById('ttLinks');
  var nodes = [].slice.call(world.querySelectorAll('.tt-node'));
  var zoomLabel = document.getElementById('ttZoom');

  var MIN = 0.35, MAX = 2.2;
  var k = 1, tx = 0, ty = 0;
  var frame = null;

  function editing() { return document.body.classList.contains('wba-editing'); }

  /* ---------------------------------------------------------------- paint - */
  function apply() {
    frame = null;
    vp.style.setProperty('--k', k);
    vp.style.setProperty('--tx', tx + 'px');
    vp.style.setProperty('--ty', ty + 'px');
    if (zoomLabel) zoomLabel.textContent = Math.round(k * 100) + '%';
  }
  function schedule() { if (!frame) frame = requestAnimationFrame(apply); }

  function setView(nk, nx, ny) {
    k = Math.max(MIN, Math.min(MAX, nk));
    tx = nx; ty = ny;
    schedule();
  }

  /* Zoom about a point given in VIEWPORT coordinates. */
  function zoomAt(nextK, px, py) {
    nextK = Math.max(MIN, Math.min(MAX, nextK));
    if (nextK === k) return;
    var ratio = nextK / k;
    setView(nextK, px - (px - tx) * ratio, py - (py - ty) * ratio);
  }

  function glide(fn) {
    world.classList.add('is-gliding');
    fn();
    setTimeout(function () { world.classList.remove('is-gliding'); }, 560);
  }

  /* ------------------------------------------------------------ the wires -
     Two shapes. Stage to stage runs left to right, so the control points
     push out horizontally. A branch hangs directly above or below its stage,
     so those push out vertically. Anything else would produce a wire that
     leaves the box sideways and arrives from underneath. */
  function bezier(a, b, vertical) {
    if (vertical) {
      var d = Math.abs(b.y - a.y) * 0.45;
      var s = b.y > a.y ? 1 : -1;
      return 'M' + a.x + ',' + a.y +
             'C' + a.x + ',' + (a.y + d * s) + ' ' +
                   b.x + ',' + (b.y - d * s) + ' ' + b.x + ',' + b.y;
    }
    var h = Math.abs(b.x - a.x) * 0.5;
    return 'M' + a.x + ',' + a.y +
           'C' + (a.x + h) + ',' + a.y + ' ' +
                 (b.x - h) + ',' + b.y + ' ' + b.x + ',' + b.y;
  }

  function box(el) {
    /* World coordinates, read from the data attributes rather than measured:
       offsetWidth is affected by the parent's scale in some engines, and the
       collapsed height is what we want the wire to touch anyway. */
    var x = parseFloat(el.getAttribute('data-x')) || 0;
    var y = parseFloat(el.getAttribute('data-y')) || 0;
    var head = el.querySelector('.tt-head');
    return {
      x: x, y: y,
      w: el.offsetWidth || 236,
      h: head ? head.offsetHeight : 44
    };
  }

  var SVGNS = 'http://www.w3.org/2000/svg';

  function drawLinks() {
    if (!svg) return;
    /* createElementNS, not innerHTML. Assigning innerHTML on an <svg> element
       is not reliably parsed into the SVG namespace across engines, and an
       HTML-namespace <path> is a no-op that renders nothing and reports no
       error — which is exactly what it did. */
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    var maxX = 0, maxY = 0;

    nodes.forEach(function (el) {
      var b = box(el);
      maxX = Math.max(maxX, b.x + b.w);
      maxY = Math.max(maxY, b.y + b.h);

      var pid = el.getAttribute('data-parent');
      if (!pid) return;
      var parent = document.getElementById(pid);
      if (!parent) return;
      var p = box(parent);

      var sameColumn = Math.abs((b.x + b.w / 2) - (p.x + p.w / 2)) < 120;
      var a, c;

      if (sameColumn) {
        var above = b.y < p.y;
        a = { x: p.x + p.w / 2, y: above ? p.y : p.y + p.h };
        c = { x: b.x + b.w / 2, y: above ? b.y + b.h : b.y };
      } else {
        a = { x: p.x + p.w, y: p.y + p.h / 2 };
        c = { x: b.x,       y: b.y + b.h / 2 };
      }

      var spine = el.classList.contains('is-stage') && parent.classList.contains('is-stage');
      var path = document.createElementNS(SVGNS, 'path');
      path.setAttribute('class', 'tt-link' + (spine ? ' is-spine' : ''));
      path.setAttribute('d', bezier(a, c, sameColumn));
      svg.appendChild(path);
    });

    /* The base reset says img,svg,video{max-width:100%}. .tt-world has no
       intrinsic width, so max-width resolved to zero and the whole SVG
       collapsed to a 0x0 box that clipped every path — present in the DOM,
       correct `d`, invisible. Give the world a real size and the SVG explicit
       pixels, and the reset has something sane to work against. */
    var w = maxX + 140, h = maxY + 140;
    svg.setAttribute('width', w);
    svg.setAttribute('height', h);
    svg.style.width = w + 'px';
    svg.style.height = h + 'px';
    world.style.width = w + 'px';
    world.style.height = h + 'px';
    return { w: maxX + 80, h: maxY + 80 };
  }

  /* ------------------------------------------------------------------ fit - */
  var extent = { w: 2400, h: 1000 };

  function fit(animate) {
    var r = vp.getBoundingClientRect();
    if (!r.width) return;
    var pad = 56;
    var nk = Math.max(MIN, Math.min((r.width - pad) / extent.w, (r.height - pad) / extent.h, 1.1));
    var nx = (r.width - extent.w * nk) / 2;
    var ny = (r.height - extent.h * nk) / 2;
    if (animate) glide(function () { setView(nk, nx, ny); });
    else setView(nk, nx, ny);
  }

  /* Opening view.

     Fitting the whole map means 48% on a laptop, at which the node labels are
     too small to read and the thing reads as a diagram of a map rather than a
     map. So it opens standing next to stage one, at a size you can actually
     read, and you go and find the rest. The fit button is there for anyone
     who wants the overview. */
  function home(animate) {
    var r = vp.getBoundingClientRect();
    if (!r.width) return;
    var nk = r.width < 620 ? 0.72 : 0.86;
    var focus = document.getElementById('n1');
    var fx = focus ? (parseFloat(focus.getAttribute('data-x')) || 0) : 0;
    var fy = focus ? (parseFloat(focus.getAttribute('data-y')) || 0) : 0;
    /* Put stage one a third of the way in, vertically centred. */
    var nx = r.width * 0.28 - fx * nk;
    var ny = r.height / 2 - (fy + 22) * nk;
    if (animate) glide(function () { setView(nk, nx, ny); });
    else setView(nk, nx, ny);
  }

  /* ----------------------------------------------------------------- pan - */
  var panning = false, sx = 0, sy = 0, stx = 0, sty = 0, pid = null;

  vp.addEventListener('pointerdown', function (e) {
    if (editing()) return;
    if (e.button !== 0) return;
    if (e.target.closest('.tt-node')) return;   /* nodes take their own clicks */
    panning = true; pid = e.pointerId;
    sx = e.clientX; sy = e.clientY; stx = tx; sty = ty;
    vp.classList.add('is-panning');
    vp.setPointerCapture(e.pointerId);
  });

  vp.addEventListener('pointermove', function (e) {
    if (!panning || e.pointerId !== pid) return;
    tx = stx + (e.clientX - sx);
    ty = sty + (e.clientY - sy);
    schedule();
  });

  function endPan(e) {
    if (!panning) return;
    panning = false;
    vp.classList.remove('is-panning');
    try { vp.releasePointerCapture(e.pointerId); } catch (err) {}
  }
  vp.addEventListener('pointerup', endPan);
  vp.addEventListener('pointercancel', endPan);
  vp.addEventListener('pointerleave', endPan);

  /* ---------------------------------------------------------------- zoom - */
  vp.addEventListener('wheel', function (e) {
    /* Plain wheel is left alone so the page keeps scrolling. A trackpad
       pinch arrives here as a wheel event with ctrlKey set, which is why
       this one condition covers both gestures. */
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    var r = vp.getBoundingClientRect();
    zoomAt(k * Math.pow(0.9988, e.deltaY), e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });

  vp.addEventListener('dblclick', function (e) {
    if (e.target.closest('.tt-node')) return;
    var r = vp.getBoundingClientRect();
    glide(function () {
      zoomAt(e.shiftKey ? k / 1.6 : k * 1.6, e.clientX - r.left, e.clientY - r.top);
    });
  });

  function button(id, fn) {
    var b = document.getElementById(id);
    if (b) b.addEventListener('click', fn);
  }
  function zoomCentre(mult) {
    var r = vp.getBoundingClientRect();
    glide(function () { zoomAt(k * mult, r.width / 2, r.height / 2); });
  }
  button('ttIn',  function () { zoomCentre(1.35); });
  button('ttOut', function () { zoomCentre(1 / 1.35); });
  button('ttFit', function () { fit(true); });
  button('ttHome', function () { home(true); });

  /* Keyboard, because a canvas you can only reach with a mouse is a canvas
     half the people cannot use. */
  vp.addEventListener('keydown', function (e) {
    var step = 90;
    var moves = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    if (moves[e.key]) {
      e.preventDefault();
      setView(k, tx + moves[e.key][0], ty + moves[e.key][1]);
    }
    if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomCentre(1.3); }
    if (e.key === '-' || e.key === '_') { e.preventDefault(); zoomCentre(1 / 1.3); }
    if (e.key === '0') { e.preventDefault(); fit(true); }
    if (e.key === '1') { e.preventDefault(); home(true); }
  });

  /* --------------------------------------------------------- pinch (touch) -
     One finger is left to the page so the canvas never traps a scroll.
     Two fingers pan and zoom together, which is what a map does. */
  var touches = {}, pinchStart = 0, pinchK = 1, pinchMid = null, pinchT = null;

  function points() {
    return Object.keys(touches).map(function (id) { return touches[id]; });
  }
  vp.addEventListener('pointerdown', function (e) {
    if (e.pointerType !== 'touch') return;
    touches[e.pointerId] = { x: e.clientX, y: e.clientY };
    var p = points();
    if (p.length === 2) {
      var r = vp.getBoundingClientRect();
      pinchStart = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
      pinchK = k;
      pinchMid = { x: (p[0].x + p[1].x) / 2 - r.left, y: (p[0].y + p[1].y) / 2 - r.top };
      pinchT = { x: tx, y: ty };
    }
  });
  vp.addEventListener('pointermove', function (e) {
    if (e.pointerType !== 'touch' || !touches[e.pointerId]) return;
    touches[e.pointerId] = { x: e.clientX, y: e.clientY };
    var p = points();
    if (p.length !== 2 || !pinchStart) return;
    e.preventDefault();
    var dist = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
    var nk = Math.max(MIN, Math.min(MAX, pinchK * (dist / pinchStart)));
    var ratio = nk / pinchK;
    setView(nk,
      pinchMid.x - (pinchMid.x - pinchT.x) * ratio,
      pinchMid.y - (pinchMid.y - pinchT.y) * ratio);
  }, { passive: false });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (ev) {
    vp.addEventListener(ev, function (e) {
      delete touches[e.pointerId];
      if (points().length < 2) pinchStart = 0;
    });
  });

  /* ---------------------------------------------------------- the nodes - */
  nodes.forEach(function (el) {
    var head = el.querySelector('.tt-head');
    var drop = el.querySelector('.tt-drop');
    if (!head || !drop) return;

    head.setAttribute('aria-expanded', 'false');
    head.addEventListener('click', function (e) {
      e.stopPropagation();
      var open = el.classList.toggle('is-open');
      head.setAttribute('aria-expanded', open ? 'true' : 'false');
      /* Only one node open at a time keeps the wires readable and stops two
         expanded cards overlapping each other. */
      if (open) {
        nodes.forEach(function (o) {
          if (o !== el && o.classList.contains('is-open')) {
            o.classList.remove('is-open', 'is-zoomed');
            var h = o.querySelector('.tt-head');
            if (h) h.setAttribute('aria-expanded', 'false');
          }
        });
      }
    });

    var thumb = el.querySelector('.tt-thumb');
    if (thumb) {
      thumb.addEventListener('click', function (e) {
        e.stopPropagation();
        var z = el.classList.toggle('is-zoomed');
        thumb.setAttribute('aria-label', z ? 'Shrink' : 'Enlarge');
      });
    }
  });

  /* ---------------------------------------------------------------- boot - */
  function boot() {
    var e = drawLinks();
    if (e) extent = e;
    home(false);
  }

  /* The window it lives in can start folded, in which case the viewport has
     no size and fit() would divide by zero. Watch for it opening. */
  if (window.ResizeObserver) {
    var seen = false;
    new ResizeObserver(function () {
      var r = vp.getBoundingClientRect();
      if (r.width > 0 && !seen) { seen = true; boot(); }
    }).observe(vp);
  }

  if (document.readyState === 'complete') boot();
  else window.addEventListener('load', boot);

  var rt = null;
  window.addEventListener('resize', function () {
    clearTimeout(rt);
    rt = setTimeout(function () { home(false); }, 200);
  }, { passive: true });
})();
