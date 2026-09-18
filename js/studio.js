(function(){
 'use strict';
 var toggle=document.querySelector('.studio-menu-toggle'),menu=document.getElementById('studio-menu');
 function close(){if(!menu||!toggle)return;menu.classList.remove('is-open');toggle.setAttribute('aria-expanded','false');toggle.querySelector('span').textContent='+';}
 if(toggle&&menu){toggle.addEventListener('click',function(){var open=toggle.getAttribute('aria-expanded')!=='true';menu.classList.toggle('is-open',open);toggle.setAttribute('aria-expanded',String(open));toggle.querySelector('span').textContent=open?'−':'+';});document.addEventListener('keydown',function(e){if(e.key==='Escape'&&toggle.getAttribute('aria-expanded')==='true'){close();toggle.focus();}});menu.addEventListener('click',function(e){if(e.target.closest('a'))close();});document.addEventListener('click',function(e){if(!e.target.closest('.studio-nav'))close();});}
 document.querySelectorAll('.studio-menu a').forEach(function(a){if(a.getAttribute('href')===location.pathname)a.setAttribute('aria-current','page');});
 // Return focus to the contact form after its existing success dialog closes.
 if(document.getElementById('talkForm')){var oldClose=window.closeModal;window.closeModal=function(){if(oldClose)oldClose();document.getElementById('tSend').focus();};}
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
