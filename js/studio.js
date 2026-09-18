(function(){
 'use strict';
 var toggle=document.querySelector('.studio-menu-toggle'),menu=document.getElementById('studio-menu'),nav=document.querySelector('.studio-nav');
 var mobile=window.matchMedia('(max-width:760px)');
 function setOpen(open){if(!toggle||!menu)return;menu.classList.toggle('is-open',open);toggle.setAttribute('aria-expanded',String(open));menu.inert=mobile.matches&&!open;nav.classList.toggle('menu-open',open);}
 if(toggle&&menu){
  var icon=toggle.querySelector('span');icon.textContent='';icon.classList.add('menu-icon');icon.setAttribute('aria-hidden','true');
  setOpen(false);
  toggle.addEventListener('click',function(){setOpen(toggle.getAttribute('aria-expanded')!=='true');});
  document.addEventListener('keydown',function(e){if(e.key==='Escape'&&toggle.getAttribute('aria-expanded')==='true'){setOpen(false);toggle.focus();}});
  menu.addEventListener('click',function(e){if(e.target.closest('a'))setOpen(false);});
  document.addEventListener('click',function(e){if(!nav.contains(e.target))setOpen(false);});
  nav.addEventListener('focusout',function(e){if(e.relatedTarget&&!nav.contains(e.relatedTarget))setOpen(false);});
  mobile.addEventListener('change',function(){setOpen(false);});
 }
 document.querySelectorAll('.studio-menu a').forEach(function(a){var href=a.getAttribute('href');if(href===location.pathname||(href==='/work/'&&location.pathname.indexOf('/work/')===0))a.setAttribute('aria-current','page');});
 if(document.getElementById('talkForm')){var oldClose=window.closeModal;window.closeModal=function(){if(oldClose)oldClose();document.getElementById('tSend').focus();};}
 var reduced=window.matchMedia('(prefers-reduced-motion: reduce)');
 // Animate only when entering view. Content is visible even if JavaScript fails.
 if('IntersectionObserver' in window&&!reduced.matches){
  var observer=new IntersectionObserver(function(entries){entries.forEach(function(entry){if(entry.isIntersecting){entry.target.classList.add('is-arriving');observer.unobserve(entry.target);}});},{threshold:.08});
  document.querySelectorAll('.unusual-offer>div,.unusual-services>a,.unusual-projects>a,.work-collection>a,.service-section>div,.included-grid>div,.project-story>div,.post-card,.subscription-details>div,.enquiry-layout>div,.enquiry-layout>form').forEach(function(el,i){el.style.setProperty('--arrival-delay',(i%3)*65+'ms');observer.observe(el);});
 }
})();
// Keep the quick navigation aligned with the section currently being read.
(function(){
 var links=Array.from(document.querySelectorAll('.quick-nav a[href^="#"]'));
 if(!links.length)return;
 var sections=links.map(function(a){return document.querySelector(a.getAttribute('href'));});
 var queued=false;
 function update(){queued=false;var current=-1;sections.forEach(function(s,i){if(s&&s.getBoundingClientRect().top<=180)current=i;});links.forEach(function(a,i){if(i===current)a.setAttribute('aria-current','location');else a.removeAttribute('aria-current');});}
 window.addEventListener('scroll',function(){if(!queued){queued=true;requestAnimationFrame(update);}},{passive:true});update();
})();
// An enquiry starts with context, not a required questionnaire. Nothing is sent here.
(function(){
 var form=document.getElementById('enquiry-start');if(!form)return;
 var service=document.getElementById('enquiry-service'),context=document.getElementById('enquiry-context');
 var requested=new URLSearchParams(location.search).get('service');
 if(['website','systems','design','marketing'].includes(requested))service.value=requested;
 function describe(){context.textContent=service.value==='website'?'£30/month. No upfront design or build fee.':'';}
 service.addEventListener('change',describe);describe();
 form.addEventListener('submit',function(event){event.preventDefault();var business=document.getElementById('enquiry-business').value.trim(),note=document.getElementById('enquiry-note').value.trim();var about={website:'a website (£30/month)',systems:'an app or business system',design:'branding and design',marketing:'digital marketing'};var lines=['Hi WBA, I’d like to talk about '+(about[service.value]||'my business')+'.'];if(business)lines.push('Business: '+business);var text=lines.join('\n')+(note?'\n\n'+note:'');location.href='https://wa.me/447447571425?text='+encodeURIComponent(text);});
})();
// The hero moves as one scene, with restrained depth rather than scroll effects.
(function(){
 var hero=document.querySelector('.unusual-hero');if(!hero)return;
 var photo=hero.querySelector('.unusual-photo'),title=hero.querySelector('h1');
 var enabled=window.matchMedia('(hover: hover) and (pointer: fine) and (prefers-reduced-motion: no-preference)');
 var targetX=0,targetY=0,x=0,y=0,frame=0;
 function reset(){cancelAnimationFrame(frame);frame=0;x=y=targetX=targetY=0;hero.classList.remove('has-depth');photo.style.removeProperty('transform');title.style.removeProperty('transform');}
 function tick(){x+=(targetX-x)*.065;y+=(targetY-y)*.065;photo.style.transform='translate3d('+(x*10).toFixed(2)+'px,'+(y*7).toFixed(2)+'px,0) scale(1.045)';title.style.transform='translate3d('+(-x*3).toFixed(2)+'px,'+(-y*2).toFixed(2)+'px,0)';if(Math.abs(targetX-x)+Math.abs(targetY-y)>.002)frame=requestAnimationFrame(tick);else frame=0;}
 function move(event){if(!enabled.matches)return;var box=hero.getBoundingClientRect();targetX=Math.max(-1,Math.min(1,(event.clientX-box.left)/box.width*2-1));targetY=Math.max(-1,Math.min(1,(event.clientY-box.top)/box.height*2-1));hero.classList.add('has-depth');if(!frame)frame=requestAnimationFrame(tick);}
 hero.addEventListener('pointermove',move,{passive:true});
 hero.addEventListener('pointerleave',function(){targetX=targetY=0;if(enabled.matches&&!frame)frame=requestAnimationFrame(tick);});
 enabled.addEventListener('change',reset);
 document.addEventListener('visibilitychange',function(){if(document.hidden)reset();});
})();
