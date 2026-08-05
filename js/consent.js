/* ==========================================================================
   WBA — minimal cookie consent, only for the things that actually need it.

   Our own analytics (js/analytics.js) is cookieless and anonymous, so it runs
   regardless and is NOT gated here. This gates third-party tracking only:
   Meta Pixel, and Clarity if you ever add it.

   Load on every page BEFORE analytics.js:
       <script src="js/consent.js" defer></script>

   Set META_PIXEL_ID when you have one. Leave blank and nothing loads.
   ========================================================================== */
(function () {
  'use strict';

  var META_PIXEL_ID = '';          // <-- paste your pixel ID here when you have one
  var CLARITY_ID    = '';          // <-- optional, leave blank

  var STORE = 'wba_consent';       // 'yes' | 'no'

  function get() { try { return localStorage.getItem(STORE); } catch (e) { return null; } }
  function set(v) { try { localStorage.setItem(STORE, v); } catch (e) {} }

  /* ------------------------------------------------------------ Meta Pixel */
  function loadPixel() {
    if (!META_PIXEL_ID || window.fbq) return;
    /* eslint-disable */
    !function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?
    n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;
    n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;
    t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}
    (window,document,'script','https://connect.facebook.net/en_US/fbevents.js');
    /* eslint-enable */
    fbq('init', META_PIXEL_ID);
    fbq('track', 'PageView');
  }

  function loadClarity() {
    if (!CLARITY_ID || window.clarity) return;
    /* eslint-disable */
    (function(c,l,a,r,i,t,y){c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};
    t=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i;
    y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y)})
    (window,document,"clarity","script",CLARITY_ID);
    /* eslint-enable */
  }

  function enable() { loadPixel(); loadClarity(); }
  window.wbaEnableTracking = enable;

  /* Already answered — act on it and show nothing. */
  var prior = get();
  if (prior === 'yes') { enable(); return; }
  if (prior === 'no') { return; }

  /* Nothing to consent to yet — don't show a banner for the sake of it. */
  if (!META_PIXEL_ID && !CLARITY_ID) return;

  /* ---------------------------------------------------------------- banner */
  function build() {
    var bar = document.createElement('div');
    bar.id = 'wbaConsent';
    bar.setAttribute('role', 'dialog');
    bar.setAttribute('aria-label', 'Cookie choice');
    bar.innerHTML =
      '<p>We use a couple of cookies to see which ads bring people here. ' +
      'Nothing else. <a href="/privacy">Privacy</a></p>' +
      '<div class="wbaConsentBtns">' +
        '<button type="button" data-a="no">Decline</button>' +
        '<button type="button" data-a="yes" class="wbaConsentYes">Allow</button>' +
      '</div>';

    var css = document.createElement('style');
    css.textContent =
      '#wbaConsent{position:fixed;left:16px;right:16px;bottom:16px;z-index:9999;' +
      'max-width:560px;margin:0 auto;background:#0b1220;color:#fff;border-radius:14px;' +
      'padding:16px 18px;display:flex;gap:14px;align-items:center;flex-wrap:wrap;' +
      'box-shadow:0 12px 40px rgba(0,0,0,.35);font-size:14px;line-height:1.45}' +
      '#wbaConsent p{margin:0;flex:1 1 240px}' +
      '#wbaConsent a{color:#fff;text-decoration:underline}' +
      '#wbaConsent .wbaConsentBtns{display:flex;gap:8px;flex:0 0 auto}' +
      '#wbaConsent button{cursor:pointer;border:0;border-radius:100px;padding:9px 18px;' +
      'font:inherit;font-weight:600;background:transparent;color:#fff;' +
      'border:1px solid rgba(255,255,255,.35)}' +
      '#wbaConsent button.wbaConsentYes{background:#fff;color:#0b1220;border-color:#fff}' +
      '@media(max-width:520px){#wbaConsent{flex-direction:column;align-items:stretch}' +
      '#wbaConsent .wbaConsentBtns{justify-content:flex-end}}';

    document.head.appendChild(css);
    document.body.appendChild(bar);

    bar.addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b) return;
      var a = b.getAttribute('data-a');
      set(a);
      if (a === 'yes') enable();
      bar.remove();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', build);
  } else {
    build();
  }
})();
