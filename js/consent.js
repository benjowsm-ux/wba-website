/* ==========================================================================
   WBA — cookie consent, only for things that genuinely need it.

   Our own analytics (js/analytics.js) is cookieless and anonymous, so it runs
   regardless and is NOT gated here. This file exists solely as the gate for
   any third-party tool we might add later that DOES set cookies.

   Right now nothing is configured, so nothing loads and no banner appears —
   which is the correct behaviour, not an oversight. Set an ID below and the
   banner starts doing its job automatically.
   ========================================================================== */
(function () {
  'use strict';

  var CLARITY_ID = '';             // Microsoft Clarity, optional. Blank = off.

  var STORE = 'wba_consent';       // 'yes' | 'no'
  function get(){ try{ return localStorage.getItem(STORE); }catch(e){ return null; } }
  function set(v){ try{ localStorage.setItem(STORE, v); }catch(e){} }

  function loadClarity() {
    if (!CLARITY_ID || window.clarity) return;
    /* eslint-disable */
    (function(c,l,a,r,i,t,y){c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};
    t=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i;
    y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y)})
    (window,document,"clarity","script",CLARITY_ID);
    /* eslint-enable */
  }

  function enable(){ loadClarity(); }
  window.wbaEnableTracking = enable;

  var prior = get();
  if (prior === 'yes') { enable(); return; }
  if (prior === 'no') return;

  /* Nothing to consent to — don't show a banner for the sake of it. */
  if (!CLARITY_ID) return;

  function build() {
    var bar = document.createElement('div');
    bar.id = 'wbaConsent';
    bar.setAttribute('role', 'dialog');
    bar.setAttribute('aria-label', 'Cookie choice');
    bar.innerHTML =
      '<p>We use a couple of cookies to understand how the site is used. ' +
      'Nothing else. <a href="/privacy/">Privacy</a></p>' +
      '<div class="wbaConsentBtns">' +
        '<button type="button" data-a="no">Decline</button>' +
        '<button type="button" data-a="yes" class="wbaConsentYes">Allow</button>' +
      '</div>';

    var css = document.createElement('style');
    css.textContent =
      '#wbaConsent{position:fixed;left:16px;right:16px;bottom:16px;z-index:9999;' +
      'max-width:560px;margin:0 auto;background:#0b1220;color:#fff;border-radius:16px;' +
      'padding:16px 18px;display:flex;gap:14px;align-items:center;flex-wrap:wrap;' +
      'box-shadow:0 12px 40px rgba(0,0,0,.35);font-size:14px;line-height:1.45}' +
      '#wbaConsent p{margin:0;flex:1 1 240px}' +
      '#wbaConsent a{color:#fff;text-decoration:underline}' +
      '#wbaConsent .wbaConsentBtns{display:flex;gap:8px;flex:0 0 auto}' +
      '#wbaConsent button{cursor:pointer;border-radius:100px;padding:9px 18px;' +
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

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build);
  else build();
})();
