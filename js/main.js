/* ==========================================================================
   WBA — shared site behaviour. Loaded on every page.
   ========================================================================== */

/* ---- Scroll reveal ----
   Sections start at opacity:0 and fade in. That's a nice effect but a real
   risk: if IntersectionObserver never fires (old browser, screenshot tool,
   print, a JS error above this line) the content stays invisible. So we
   always guarantee visibility, and treat the animation as a bonus. */
(function(){
  function revealAll(){ document.querySelectorAll('.reveal:not(.in)').forEach(function(el){ el.classList.add('in'); }); }

  if(!('IntersectionObserver' in window)){ revealAll(); return; }

  var ro = new IntersectionObserver(function(entries){
    entries.forEach(function(x){ if(x.isIntersecting) x.target.classList.add('in'); });
  }, {threshold:0.08, rootMargin:'0px 0px -40px 0px'});
  document.querySelectorAll('.reveal').forEach(function(el){ ro.observe(el); });

  /* Failsafe — nothing stays hidden for more than 2.5s, whatever happens. */
  setTimeout(revealAll, 2500);
  /* Print / screenshot: show everything immediately. */
  window.addEventListener('beforeprint', revealAll);
})();

/* ---- Mobile nav ---- */
function toggleNav(){
  var links = document.getElementById('navLinks');
  var btn = document.querySelector('.nav-toggle');
  if(!links) return;
  links.classList.toggle('open');
  if(btn) btn.classList.toggle('open');
}

/* ---- Clients "show more" (home/about) ---- */
function toggleClients(){
  document.querySelectorAll('.c-hidden').forEach(function(c){ c.style.display='flex'; });
  var m = document.getElementById('moreChip');
  if(m) m.style.display='none';
}

/* ---- FAQ accordion ---- */
function toggleFaq(btn){
  var item = btn.closest('.faq-item');
  if(!item) return;
  var open = item.classList.contains('open');
  item.classList.toggle('open');
  var a = item.querySelector('.faq-a');
  if(a) a.style.maxHeight = open ? null : a.scrollHeight + 'px';
}

/* ---- Forms ----
   Every enquiry is sent TWO places: the email service (so we get a nudge)
   and our own Supabase table (so the lead is never lost if the email
   service is down, rate-limited, or over its monthly quota).
   The submission counts as successful if EITHER lands. */
var WBA_FORM_ENDPOINT = 'https://formspree.io/f/mvzdgzka';
var WBA_SB = 'https://lynzhiyvggqyplssrapi.supabase.co';
var WBA_SB_KEY = 'sb_publishable_j_RkzVTMyM-QtmFnLsf_Vw_ulanlx9K';

function wbaSaveLead(payload){
  var summary = Object.keys(payload)
    .filter(function(k){ return k.charAt(0) !== '_' && payload[k]; })
    .map(function(k){ return k + ': ' + payload[k]; }).join('\n');
  return fetch(WBA_SB + '/rest/v1/submissions', {
    method:'POST',
    headers:{ apikey:WBA_SB_KEY, Authorization:'Bearer ' + WBA_SB_KEY,
              'Content-Type':'application/json', Prefer:'return=minimal' },
    body: JSON.stringify({
      type:'enquiry',
      title: payload.business || payload.name || 'Website enquiry',
      description: summary,
      submitter_name: payload.name || '',
      submitter_email: payload.email || payload.contact || '',
      location: location.pathname
    })
  });
}

async function postForm(payload){
  var email = fetch(WBA_FORM_ENDPOINT, {
    method:'POST',
    headers:{'Content-Type':'application/json','Accept':'application/json'},
    body:JSON.stringify(payload)
  }).then(function(r){ return r.ok; }).catch(function(){ return false; });

  var saved = wbaSaveLead(payload).then(function(r){ return r.ok; }).catch(function(){ return false; });

  var results = await Promise.all([email, saved]);
  /* Mimic a fetch Response so existing callers keep working unchanged. */
  return { ok: results[0] || results[1], emailed: results[0], stored: results[1] };
}

async function quickSubmit(){
  var n = document.getElementById('qname').value.trim();
  var p = document.getElementById('qphone').value.trim();
  if(!n || !p){ alert('Please add your name and a contact.'); return; }
  try{
    var r = await postForm({name:n, contact:p, _subject:'Quick Enquiry — WBA Website'});
    if(r.ok){
      document.getElementById('qname').value='';
      document.getElementById('qphone').value='';
      showModal();
    } else throw new Error();
  }catch(e){ window.open('https://wa.me/447902376369','_blank'); }
}

async function submitForm(){
  var name = document.getElementById('fname').value.trim();
  var biz = document.getElementById('fbiz').value.trim();
  var email = document.getElementById('femail').value.trim();
  var method = document.getElementById('fmethod').value;
  var msg = document.getElementById('fmsg').value.trim();
  var s = document.getElementById('sendStatus');
  if(!name || !biz || !email){
    s.className='send-status err';
    s.textContent='Please fill in your name, business and email.';
    return;
  }
  s.className='send-status'; s.textContent='Sending...';
  try{
    var r = await postForm({name:name, business:biz, contact:method||'Not specified', email:email, message:msg||'No message', _subject:'Visit Request — '+biz});
    if(r.ok){
      ['fname','fbiz','femail','fmsg'].forEach(function(id){ document.getElementById(id).value=''; });
      document.getElementById('fmethod').selectedIndex=0;
      s.textContent=''; showModal();
    } else throw new Error();
  }catch(e){
    s.className='send-status err';
    s.textContent='Something went wrong — please WhatsApp us on 07902 376369.';
  }
}

function showModal(){ var m=document.getElementById('modal'); if(m) m.classList.add('show'); }
function closeModal(){ var m=document.getElementById('modal'); if(m) m.classList.remove('show'); }

/* Weston Guide — "suggest a spot/event" box */
async function suggestSubmit(){
  var msg = document.getElementById('sgmsg').value.trim();
  var name = document.getElementById('sgname').value.trim();
  var s = document.getElementById('sgStatus');
  if(!msg){ s.className='send-status err'; s.textContent='Add a suggestion first.'; return; }
  s.className='send-status'; s.textContent='Sending...';
  try{
    var r = await postForm({name:name||'Anonymous', suggestion:msg, _subject:'Weston Guide suggestion'});
    if(r.ok){
      document.getElementById('sgmsg').value='';
      document.getElementById('sgname').value='';
      s.className='send-status ok'; s.textContent='Thanks! Suggestion received.';
    } else throw new Error();
  }catch(e){ s.className='send-status err'; s.textContent='Something went wrong — WhatsApp us on 07902 376369.'; }
}

/* ---- Weekly news: 52 features, auto-rotates by calendar week (free, no backend) ---- */
var WBA_FEATURES = [
  {tag:"New Year", title:"New year, new customers — start where they're looking.", text:"January is when locals reset and search for someone better. Make sure your Google profile, socials and website actually show up when Weston searches.", cta:"Get found →"},
  {tag:"Off-season", title:"The quiet weeks are when smart businesses get ahead.", text:"Trade's slower in January — perfect for sorting your photos, posts and online presence before spring. Your competitors are doing nothing. You shouldn't be.", cta:"Plan your year →"},
  {tag:"Visibility", title:"When did you last post? Your customers noticed.", text:"An empty feed makes a busy business look closed. We keep your socials alive so you stay front of mind, even in the slow season.", cta:"Stay visible →"},
  {tag:"Local SEO", title:"Your Google listing is your new shop window.", text:"Most people decide before they ever walk in. A tidy, photo-rich Google profile with recent reviews wins the customer your rival just lost.", cta:"Sort my listing →"},
  {tag:"Half term", title:"Half term is coming — are the families finding you?", text:"February half term brings families into Weston looking for somewhere to eat, play and stay. Be the easy 'yes' when they search.", cta:"Get ready →"},
  {tag:"Valentine's", title:"Valentine's: the businesses that book up plan ahead.", text:"Couples are searching now for tables, treats and gifts. A simple post and a clear offer turns scrollers into bookings.", cta:"Fill your tables →"},
  {tag:"Reviews", title:"Winter reviews win you summer customers.", text:"A steady trickle of fresh 5-star reviews tells next season's visitors you're the safe choice. We make asking for them effortless.", cta:"Build my reviews →"},
  {tag:"Photography", title:"Cheap photos cost you customers.", text:"Blurry, dark snaps make great businesses look average. Proper photography pays for itself the first time someone chooses you because of it.", cta:"Book a shoot →"},
  {tag:"Spring", title:"Spring's nearly here — is your marketing awake?", text:"As the days lighten, footfall starts to build. Get your posts, offers and listings sorted now so you're ready the moment people come out.", cta:"Spring clean →"},
  {tag:"Spring", title:"The clocks change soon — and so does buyer behaviour.", text:"Lighter evenings mean more people out and about in Weston. Make sure your business is the one they spot, online and on the street.", cta:"Catch the rush →"},
  {tag:"Mother's Day", title:"Mother's Day books up fast — be ready early.", text:"Tables, bouquets, treats and gifts get searched weeks ahead. One clear offer, posted in time, can make your busiest day of spring.", cta:"Promote your offer →"},
  {tag:"Easter", title:"Easter's coming — and so are the day trippers.", text:"The first big holiday weekend fills Weston with visitors. Make sure your hours, photos and offers are front and centre when they search.", cta:"Get Easter ready →"},
  {tag:"Website", title:"A website that doesn't load fast is losing you money.", text:"Visitors give you seconds. A clean, quick, mobile-friendly site keeps them — and turns them into customers.", cta:"Fix my website →"},
  {tag:"Easter", title:"Easter holidays: peak season's warm-up act.", text:"Families are in town all week. Keep your socials posting daily and your offers visible — this is your dress rehearsal for summer.", cta:"Make the most of it →"},
  {tag:"Footfall", title:"The seafront's filling up. Are you in the conversation?", text:"As Weston gets busy, people decide on their phones in real time. Regular posts and a strong Google profile put you in front of them.", cta:"Get noticed →"},
  {tag:"Bank holiday", title:"Spring bank holidays bring crowds — plan your push.", text:"Back-to-back long weekends mean back-to-back opportunities. A simple content plan means you're never scrambling on the busy days.", cta:"Plan my campaign →"},
  {tag:"Branding", title:"Tidy socials, tidy reputation.", text:"Your feed is judged like your shopfront. We keep it consistent, on-brand and posting — so you always look the part.", cta:"Tidy my socials →"},
  {tag:"Half term", title:"May half term: families are choosing right now.", text:"Where to eat, what to do, where to stay — it's all being searched this week. Make your business the obvious answer.", cta:"Win half term →"},
  {tag:"Summer prep", title:"Summer's nearly here — lock in your visibility now.", text:"The businesses that own summer set it up in spring. Get your photos, posts and ads ready before the rush, not during it.", cta:"Get summer-ready →"},
  {tag:"Holiday lets", title:"Holiday lets: your booking calendar starts online.", text:"Great photos and a strong listing are the difference between booked-out and empty weekends. Let's fill your season.", cta:"Fill my calendar →"},
  {tag:"Paid ads", title:"Paid ads put you in front of visitors before they arrive.", text:"People plan their Weston trip days ahead. A small, well-aimed ad budget reaches them while they're still deciding.", cta:"Reach visitors →"},
  {tag:"Summer", title:"The sun's coming back — is your business ready for summer footfall?", text:"Weston had a taste of the heat and the seafront was packed. Make sure your business is the one day trippers find when they reach for their phones.", cta:"Get summer-ready →"},
  {tag:"Summer", title:"Longest days, biggest crowds — make every one count.", text:"Summer footfall is here. Daily posts, fresh photos and a visible offer turn passers-by into paying customers.", cta:"Capture the crowds →"},
  {tag:"Events", title:"Weddings and events: be the local name people remember.", text:"Summer's the season of celebrations. Get your work in front of the people planning them with content that shows off your best.", cta:"Show your work →"},
  {tag:"Tourism", title:"Tourists decide on their phones — be the easy choice.", text:"Visitors don't know the area. The business with clear photos, hours and reviews wins them every time. Make that you.", cta:"Be the easy yes →"},
  {tag:"Peak season", title:"Peak season is here. Don't leave money on the table.", text:"When you're this busy, marketing feels like the last thing you have time for — which is exactly why letting us handle it pays off.", cta:"Hand it over →"},
  {tag:"School holidays", title:"School holidays start — Weston fills up.", text:"Six weeks of families looking for things to do, eat and book. Keep posting daily and stay top of the list.", cta:"Win the holidays →"},
  {tag:"Visibility", title:"Busy is good. Busy and invisible is a missed chance.", text:"Even at your busiest, the customers walking past still need to find you online. We keep you visible while you keep serving.", cta:"Stay seen →"},
  {tag:"Content", title:"Capture summer now — it sells all winter.", text:"The photos and clips we take while you're packed become the content that keeps you booked through the quiet months.", cta:"Bank the content →"},
  {tag:"Reviews", title:"Peak footfall = peak review season.", text:"More customers means more chances for 5-star reviews. We make asking automatic, so your reputation grows on its own.", cta:"Grow my reviews →"},
  {tag:"Bank holiday", title:"Make the August bank holiday your best yet.", text:"The last big push of summer. A clear offer, posted in time, turns the bank holiday crowd into your record weekend.", cta:"Plan the weekend →"},
  {tag:"Late summer", title:"Don't let summer end quietly — finish strong.", text:"There's still trade out there. Keep your marketing switched on right to the end of the season and bank every last customer.", cta:"Finish strong →"},
  {tag:"Autumn", title:"Back to school, back to the locals.", text:"As visitors thin out, your regulars return. Shift your message to the community that keeps you going all year round.", cta:"Reconnect locally →"},
  {tag:"Autumn", title:"Autumn's coming — keep the momentum, don't coast.", text:"The businesses that stay visible after summer carry their bookings into winter. Don't go quiet now.", cta:"Keep it going →"},
  {tag:"Content", title:"Turn summer's photos into autumn's posts.", text:"All that great content we captured? Now's when it works hardest, keeping your feed alive as things slow down.", cta:"Put it to work →"},
  {tag:"Local SEO", title:"Quieter season, smarter marketing.", text:"With fewer walk-ins, being easy to find online matters more than ever. Let's make sure you're the one Weston picks.", cta:"Stay findable →"},
  {tag:"Half term", title:"October half term: one more family rush.", text:"Cosy season brings families out for treats and trips. Be ready with the offers and posts that pull them in.", cta:"Get ready →"},
  {tag:"Halloween", title:"Halloween: a small push, a fun payoff.", text:"A seasonal offer or themed post costs nothing and gets people talking. Easy wins keep your name in feeds.", cta:"Have some fun →"},
  {tag:"Autumn", title:"Clocks go back — your online presence works overtime.", text:"Darker evenings mean more scrolling, less strolling. Now's when strong socials and search visibility really earn their keep.", cta:"Boost visibility →"},
  {tag:"Christmas prep", title:"Christmas books up earlier than you think.", text:"People are already searching for festive tables, gifts and slots. Get your offers up now and beat the rush.", cta:"Start early →"},
  {tag:"Black Friday", title:"Black Friday isn't just for big shops.", text:"A simple local offer cuts through the noise. We'll help you stand out without slashing your prices to nothing.", cta:"Plan my offer →"},
  {tag:"Christmas", title:"Festive bookings go to whoever's visible first.", text:"The business that's posting, advertising and easy to find gets the Christmas trade. Let's make that you.", cta:"Fill December →"},
  {tag:"Gift vouchers", title:"Gift vouchers: income now, customers later.", text:"Sell a voucher today, gain a customer in January. We'll help you promote them so they actually sell.", cta:"Sell vouchers →"},
  {tag:"Christmas", title:"Don't go dark in December — go all in.", text:"It's your busiest selling window. Daily posts and clear offers turn festive browsers into paying customers.", cta:"Make it count →"},
  {tag:"Christmas", title:"Last-minute shoppers are searching right now.", text:"Late bookings and gift hunts spike this week. Be the visible, easy option when they're running out of time.", cta:"Catch the rush →"},
  {tag:"Reviews", title:"Festive reviews set you up for the new year.", text:"Happy Christmas customers leave glowing reviews — if you ask. We make it effortless, so January starts strong.", cta:"Collect reviews →"},
  {tag:"Festive", title:"Between Christmas and New Year — keep showing up.", text:"Everyone else goes quiet. A few well-timed posts now mean you're the first business people remember in January.", cta:"Stay top of mind →"},
  {tag:"Planning", title:"New Year planning starts before the year does.", text:"While others wind down, smart owners line up their marketing for January. Get ahead while it's quiet.", cta:"Plan ahead →"},
  {tag:"New Year", title:"Make next year the year you stop doing your own marketing.", text:"If posting, photos and ads keep falling to the bottom of your list, hand them to a local team that does it all for you.", cta:"Let's talk →"},
  {tag:"New Year", title:"A fresh year is a fresh chance to be found.", text:"New Year resolutions send people searching for better local businesses. Make sure yours is the one that shows up.", cta:"Get found →"},
  {tag:"Strategy", title:"Consistency beats bursts, every time.", text:"One big push fades fast. Steady, week-in week-out marketing is what actually grows a local business — exactly what we handle.", cta:"Stay consistent →"},
  {tag:"Strategy", title:"Your competitors aren't better — they're just more visible.", text:"The business that shows up most usually wins, not the best one. Let's make sure Weston sees you first.", cta:"Out-show them →"}
];

function wbaWeekOfYear(d){
  var start = new Date(d.getFullYear(), 0, 1);
  var days = Math.floor((d - start) / 86400000);
  return Math.floor((days + start.getDay()) / 7);
}

/* Hourly index — the feed auto-advances every hour so it feels alive. */
function wbaHourIndex(){ return Math.floor(Date.now() / 3600000); }

/* Fills the "This Week" feature block if present on the page. */
(function(){
  var f = WBA_FEATURES[wbaHourIndex() % WBA_FEATURES.length];
  var t = document.getElementById('weeklyTitle');
  var x = document.getElementById('weeklyText');
  var c = document.getElementById('weeklyCta');
  if(t) t.textContent = f.title;
  if(x) x.textContent = f.text;
  if(c) c.textContent = f.cta;
})();

/* Builds a news grid wherever a #newsGrid container is present.
   data-count  = how many cards (default 9)
   data-start  = week offset of the first card (default 1 = next week;
                 0 includes this week, for the home-page teaser). */
(function(){
  var grid = document.getElementById('newsGrid');
  if(!grid) return;
  var count = parseInt(grid.getAttribute('data-count') || '9', 10);
  var start = parseInt(grid.getAttribute('data-start') || '1', 10);
  var base = wbaHourIndex();
  var html = '';
  for(var i=0; i<count; i++){
    var f = WBA_FEATURES[(base + start + i) % WBA_FEATURES.length];
    html += '<div class="news-card reveal">'
          + '<div class="news-tag">'+f.tag+'</div>'
          + '<h3>'+f.title+'</h3>'
          + '<p>'+f.text+'</p>'
          + '<a class="news-link" href="https://wa.me/447902376369" target="_blank">'+f.cta+'</a>'
          + '</div>';
  }
  grid.innerHTML = html;
  // re-observe the freshly added reveal cards, with a gentle stagger
  var ro = new IntersectionObserver(function(entries){
    entries.forEach(function(x){ if(x.isIntersecting) x.target.classList.add('in'); });
  }, {threshold:0.08});
  grid.querySelectorAll('.news-card').forEach(function(el, i){
    el.style.transitionDelay = (i * 0.08) + 's';
    ro.observe(el);
  });
})();

/* Live news feed — free, no API key. Weston headlines via Google News RSS through
   public relays (with fallback), showing the original source + date. */
(function(){
  var B = document.getElementById('feedBusiness');
  var T = document.getElementById('feedTourism');
  if(!B && !T) return;

  var RELAYS = [
    function(u){ return 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u); },
    function(u){ return 'https://corsproxy.io/?url=' + encodeURIComponent(u); }
  ];
  function fetchFeed(url, i){
    i = i || 0;
    if(i >= RELAYS.length) return Promise.reject();
    return fetch(RELAYS[i](url))
      .then(function(r){ if(!r.ok) throw new Error('relay'); return r.text(); })
      .catch(function(){ return fetchFeed(url, i + 1); });
  }

  function render(el, items){
    el.innerHTML = '';
    if(!items || !items.length){
      var p = document.createElement('p');
      p.className = 'feed-empty';
      p.textContent = "Couldn't load headlines right now — please check back shortly.";
      el.appendChild(p);
      return;
    }
    items.slice(0, 6).forEach(function(it){
      var a = document.createElement('a');
      a.className = 'feed-item'; a.href = it.link || '#'; a.target = '_blank'; a.rel = 'noopener';
      var t = document.createElement('span'); t.className = 'feed-title'; t.textContent = it.title || 'Untitled';
      var m = document.createElement('span'); m.className = 'feed-meta';
      var date = it.pubDate ? new Date(it.pubDate).toLocaleDateString('en-GB', {day:'numeric', month:'short'}) : '';
      m.textContent = [it.source, date].filter(Boolean).join(' · ');
      a.appendChild(t); a.appendChild(m); el.appendChild(a);
    });
  }

  function load(feedUrl, el){
    if(!el) return;
    fetchFeed(feedUrl).then(function(xml){
      var doc = new DOMParser().parseFromString(xml, 'text/xml');
      var nodes = doc.querySelectorAll('item');
      var items = Array.prototype.slice.call(nodes).map(function(it){
        var link = it.querySelector('link');
        var srcEl = it.querySelector('source');
        var title = (it.querySelector('title') || {}).textContent || '';
        var src = srcEl ? srcEl.textContent : '';
        if(src && title.slice(-(src.length + 3)) === ' - ' + src) title = title.slice(0, -(src.length + 3));
        return {
          title: title,
          link: link ? (link.getAttribute('href') || link.textContent) : '#',
          pubDate: (it.querySelector('pubDate') || {}).textContent,
          source: src
        };
      });
      render(el, items);
    }).catch(function(){ render(el, null); });
  }

  var G = 'https://news.google.com/rss/search?q=';
  var TAIL = '&hl=en-GB&gl=GB&ceid=GB:en';
  var BIZ = G + encodeURIComponent('"Weston-super-Mare" business') + TAIL;
  var TOUR = G + encodeURIComponent('"Weston-super-Mare" (tourism OR visit OR events OR attraction)') + TAIL;

  /* Prefer the pre-fetched news.json (rebuilt every 30 min by GitHub Actions —
     reliable, same-origin). Fall back to the live relay only if it's missing. */
  fetch('/news.json', { cache: 'no-store' })
    .then(function(r){ if(!r.ok) throw new Error('no news.json'); return r.json(); })
    .then(function(d){
      if(B){ (d && d.business && d.business.length) ? render(B, d.business) : load(BIZ, B); }
      if(T){ (d && d.tourism && d.tourism.length) ? render(T, d.tourism) : load(TOUR, T); }
    })
    .catch(function(){ load(BIZ, B); load(TOUR, T); });
})();

/* ---- Blog search: predictive dropdown + live grid filter + tag cloud ---- */
(function(){
  var input = document.getElementById('blogSearch');
  var dataEl = document.getElementById('blogIndexData');
  if(!input || !dataEl) return;
  var drop = document.getElementById('searchDrop');
  var posts = []; try{ posts = JSON.parse(dataEl.textContent); }catch(e){}
  var cards = {};
  document.querySelectorAll('#blogGrid .blog-card[data-slug]').forEach(function(c){ cards[c.getAttribute('data-slug')] = c; });
  function he(s){ var d = document.createElement('div'); d.textContent = (s == null ? '' : s); return d.innerHTML; }
  function score(p, q){
    var s = 0;
    if(p.title.toLowerCase().indexOf(q) > -1) s += 3;
    (p.tags || []).forEach(function(t){ if(String(t).toLowerCase().indexOf(q) > -1) s += 2; });
    if(String(p.category || '').toLowerCase().indexOf(q) > -1) s += 2;
    if(String(p.excerpt || '').toLowerCase().indexOf(q) > -1) s += 1;
    return s;
  }
  function update(){
    var q = input.value.trim().toLowerCase();
    if(!q){
      drop.style.display = 'none';
      posts.forEach(function(p){ if(cards[p.slug]) cards[p.slug].style.display = ''; });
      return;
    }
    var ranked = posts.map(function(p){ return { p: p, s: score(p, q) }; }).filter(function(r){ return r.s > 0; }).sort(function(a, b){ return b.s - a.s; });
    posts.forEach(function(p){
      if(cards[p.slug]) cards[p.slug].style.display = ranked.some(function(r){ return r.p.slug === p.slug; }) ? '' : 'none';
    });
    drop.innerHTML = ranked.slice(0, 5).map(function(r){
      return '<a href="/blog/' + encodeURIComponent(r.p.slug) + '/"><b>' + he(r.p.title) + '</b><span>' + he(r.p.category || 'blog') + '</span></a>';
    }).join('') || '<div class="sd-none">No matches — try another word or a tag.</div>';
    drop.style.display = 'block';
  }
  input.addEventListener('input', update);
  input.addEventListener('keydown', function(e){
    if(e.key === 'Enter'){ e.preventDefault(); var first = drop.querySelector('a'); if(first) location.href = first.href; }
    if(e.key === 'Escape'){ drop.style.display = 'none'; input.blur(); }
  });
  document.addEventListener('click', function(e){ if(!e.target.closest('.blog-search')) drop.style.display = 'none'; });
  document.querySelectorAll('#tagCloud .tag-go').forEach(function(t){
    t.addEventListener('click', function(){ input.value = t.getAttribute('data-tag'); input.focus(); update(); });
  });
})();

/* ---- Blog post widgets: helpful votes + suggest/report/copy (static pages) ---- */
(function(){
  var w = document.querySelector('.helpful');
  if(!w) return;
  var SB = 'https://lynzhiyvggqyplssrapi.supabase.co';
  var K = 'sb_publishable_j_RkzVTMyM-QtmFnLsf_Vw_ulanlx9K';
  var H = { apikey: K, Authorization: 'Bearer ' + K, 'Content-Type': 'application/json' };
  var slug = w.getAttribute('data-slug');
  var title = w.getAttribute('data-title') || document.title;
  var countEl = w.querySelector('.helpful-count');
  var btnsEl = w.querySelector('.helpful-btns');
  var thanksEl = w.querySelector('.helpful-thanks');

  function showCount(){
    fetch(SB + '/rest/v1/posts?slug=eq.' + encodeURIComponent(slug) + '&select=helpful_yes,helpful_no', { headers: H })
      .then(function(r){ return r.json(); })
      .then(function(d){
        var y = (d && d[0]) ? (d[0].helpful_yes || 0) : 0;
        if(y > 0) countEl.textContent = '👍 ' + y + ' reader' + (y === 1 ? '' : 's') + ' found this helpful';
      }).catch(function(){});
  }
  showCount();

  var formEl = document.getElementById('actForm');
  var labelEl = document.getElementById('actLabel');
  var msgEl = document.getElementById('actMsg');
  var actKind = 'article_update';
  function openForm(kind, label, placeholder){
    actKind = kind;
    labelEl.textContent = label;
    msgEl.placeholder = placeholder;
    formEl.hidden = false;
    msgEl.focus();
  }

  if(localStorage.getItem('wba_voted_' + slug)){ btnsEl.style.display = 'none'; thanksEl.hidden = false; }
  w.querySelectorAll('button[data-vote]').forEach(function(b){
    b.addEventListener('click', function(){
      var up = b.getAttribute('data-vote') === 'yes';
      try{ localStorage.setItem('wba_voted_' + slug, up ? 'yes' : 'no'); }catch(e){}
      btnsEl.style.display = 'none'; thanksEl.hidden = false;
      fetch(SB + '/rest/v1/rpc/vote_helpful', { method: 'POST', headers: H, body: JSON.stringify({ post_slug: slug, up: up }) })
        .then(function(){ setTimeout(showCount, 500); }).catch(function(){});
      if(!up) openForm('article_update', 'Sorry to hear it — what would make this better?', 'What was missing, unclear or out of date?');
    });
  });

  document.querySelectorAll('.article-actions button[data-act]').forEach(function(b){
    b.addEventListener('click', function(){
      var act = b.getAttribute('data-act');
      if(act === 'copy'){
        var done = function(){ b.textContent = '✓ Link copied'; setTimeout(function(){ b.textContent = '🔗 Copy link'; }, 1500); };
        if(navigator.clipboard){ navigator.clipboard.writeText(location.href).then(done).catch(done); } else { done(); }
        return;
      }
      if(act === 'update') openForm('article_update', 'Suggest an update', 'Spotted something out of date, or know something we should add?');
      if(act === 'report') openForm('article_report', 'Report an issue', "What's wrong — broken link, error, something inappropriate?");
    });
  });

  var sendBtn = document.getElementById('actSend');
  if(sendBtn) sendBtn.addEventListener('click', function(){
    var s = document.getElementById('actStatus');
    var msg = msgEl.value.trim();
    if(!msg){ s.className = 'send-status err'; s.textContent = 'Add a note first.'; return; }
    s.className = 'send-status'; s.textContent = 'Sending…';
    fetch(SB + '/rest/v1/submissions', { method: 'POST', headers: Object.assign({ Prefer: 'return=minimal' }, H),
      body: JSON.stringify({ type: actKind, title: title, description: msg, location: location.pathname, submitter_name: document.getElementById('actName').value.trim() }) })
      .then(function(r){
        if(!r.ok) throw new Error('http ' + r.status);
        formEl.innerHTML = '<p class="act-form-label">🙌 Received — a real person will read it. Thanks for making the Blog better.</p>';
      })
      .catch(function(){ s.className = 'send-status err'; s.textContent = 'Something went wrong — WhatsApp us instead: 07902 376369.'; });
  });
})();

/* ---- AAA polish: accessibility, performance, mobile CTA (every page) ---- */
(function(){
  // Mark the current nav link for assistive tech
  var active = document.querySelector('.nav-links a.active');
  if(active) active.setAttribute('aria-current', 'page');

  // Skip-to-content link + main landmark
  var main = document.querySelector('.hero, .page-hero, .weekly');
  if(main && !main.id) main.id = 'main';
  if(main){
    var skip = document.createElement('a');
    skip.href = '#main';
    skip.className = 'skip-link';
    skip.textContent = 'Skip to content';
    document.body.insertBefore(skip, document.body.firstChild);
  }

  // Async decode all images; lazy-load anything below the fold
  document.querySelectorAll('img').forEach(function(img){
    img.decoding = 'async';
    if(!img.closest('nav') && !img.closest('.hero')) img.loading = 'lazy';
  });

  // Floating WhatsApp button (mobile only, styled via .wa-fab)
  var fab = document.createElement('a');
  fab.href = 'https://wa.me/447902376369';
  fab.target = '_blank';
  fab.rel = 'noopener';
  fab.className = 'wa-fab';
  fab.setAttribute('aria-label', 'Message us on WhatsApp');
  fab.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.45 1.32 4.95L2 22l5.25-1.38c1.45.79 3.08 1.2 4.79 1.2h.01c5.46 0 9.91-4.45 9.91-9.91C21.96 6.45 17.5 2 12.04 2zm5.8 14.18c-.25.69-1.45 1.32-1.99 1.36-.53.05-1.02.24-3.45-.72-2.91-1.15-4.76-4.12-4.9-4.31-.14-.19-1.17-1.56-1.17-2.97 0-1.41.74-2.11 1-2.4.26-.29.57-.36.76-.36.19 0 .38 0 .55.01.18.01.42-.07.65.5.25.6.84 2.07.91 2.22.07.14.12.31.02.5-.09.19-.14.31-.28.48-.14.17-.29.38-.42.5-.14.14-.28.29-.12.57.16.28.71 1.17 1.53 1.9 1.05.94 1.94 1.23 2.22 1.37.28.14.44.12.6-.07.16-.19.69-.81.87-1.08.18-.28.36-.23.61-.14.25.09 1.6.76 1.87.9.28.14.46.21.53.33.07.12.07.66-.18 1.35z"/></svg>WhatsApp';
  document.body.appendChild(fab);
})();

/* ---- AAA polish: scroll progress + animated count-up stats ---- */
(function(){
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Gold scroll-progress bar
  var bar = document.createElement('div');
  bar.className = 'scroll-progress';
  document.body.appendChild(bar);
  function onScroll(){
    var h = document.documentElement;
    var max = h.scrollHeight - h.clientHeight;
    bar.style.width = (max > 0 ? (h.scrollTop / max * 100) : 0) + '%';
  }
  window.addEventListener('scroll', onScroll, {passive:true});
  onScroll();

  // Count-up: animates numbers like "11,700%", "£0", "£19.32", "100%" into view
  function animateNum(el){
    if(el.dataset.counted) return;
    el.dataset.counted = '1';
    var raw = el.textContent.trim();
    var m = raw.match(/^([^\d-]*)([\d,]+(?:\.\d+)?)(.*)$/);
    if(!m) return;
    var prefix = m[1], numStr = m[2], suffix = m[3];
    var hasComma = numStr.indexOf(',') > -1;
    var decimals = (numStr.split('.')[1] || '').length;
    var target = parseFloat(numStr.replace(/,/g, ''));
    if(reduce || isNaN(target)) return;
    var dur = 1100, start = null;
    function fmt(v){
      var s = v.toFixed(decimals);
      if(hasComma) s = Number(s).toLocaleString('en-GB', {minimumFractionDigits:decimals, maximumFractionDigits:decimals});
      return prefix + s + suffix;
    }
    function step(t){
      if(!start) start = t;
      var p = Math.min((t - start) / dur, 1);
      var eased = 1 - Math.pow(1 - p, 3);
      el.textContent = fmt(target * eased);
      if(p < 1) requestAnimationFrame(step);
      else el.textContent = prefix + numStr + suffix;
    }
    requestAnimationFrame(step);
  }
  var nums = document.querySelectorAll('.hstat-num, .astat-num, .local-stat b');
  if(nums.length){
    var io = new IntersectionObserver(function(entries){
      entries.forEach(function(x){ if(x.isIntersecting){ animateNum(x.target); io.unobserve(x.target); } });
    }, {threshold:0.4});
    nums.forEach(function(n){ io.observe(n); });
  }
})();
