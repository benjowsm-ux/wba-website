/* ==========================================================================
   WBA — client-side image preparation for the admin media library.

   Why this exists: a photo straight off a phone or a mirrorless body is
   4000-6000px wide and 6-12MB. Uploaded as-is it becomes the slowest thing
   on the page, and no amount of lazy-loading rescues it. We resize and
   re-encode in the browser before a single byte reaches Supabase.

   Nothing here touches the network. Loads before db.js.
   ========================================================================== */
(function(){
  'use strict';

  /* Formats a canvas can re-encode. Anything else (SVG, GIF, HEIC the
     browser can't decode) is passed through untouched rather than mangled. */
  var RESIZABLE = /^image\/(jpeg|png|webp)$/i;

  /* WebP is materially smaller than JPEG at the same quality and is supported
     everywhere this site targets — but only use it if the browser can encode. */
  function bestType(){
    try{
      var c = document.createElement('canvas');
      c.width = c.height = 1;
      if(c.toDataURL('image/webp').indexOf('image/webp') === 5) return 'image/webp';
    }catch(e){ /* fall through */ }
    return 'image/jpeg';
  }

  var TARGET = bestType();
  var EXT = { 'image/webp': 'webp', 'image/jpeg': 'jpg', 'image/png': 'png' };

  /* Filename that survives a URL and stays recognisable in the library. */
  function safeName(name, ext){
    var stem = String(name || 'image').replace(/\.[^.]+$/, '');
    stem = stem.toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'image';
    return stem + '.' + (ext || 'jpg');
  }

  function loadBitmap(file){
    /* createImageBitmap decodes off the main thread and, importantly, applies
       the EXIF orientation flag — so portrait phone shots don't upload sideways. */
    if(window.createImageBitmap){
      return createImageBitmap(file, { imageOrientation: 'from-image' })
        .catch(function(){ return loadViaImg(file); });
    }
    return loadViaImg(file);
  }

  function loadViaImg(file){
    return new Promise(function(resolve, reject){
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload  = function(){ URL.revokeObjectURL(url); resolve(img); };
      img.onerror = function(){ URL.revokeObjectURL(url); reject(new Error('Could not read that image.')); };
      img.src = url;
    });
  }

  /* Resolves { blob, type, ext, width, height, before, after }. */
  function shrink(file, maxEdge, quality){
    maxEdge = maxEdge || 1920;
    quality  = quality  || 0.82;

    if(!RESIZABLE.test(file.type || '')){
      return Promise.resolve({
        blob: file, type: file.type || 'application/octet-stream',
        ext: (String(file.name).split('.').pop() || 'bin').toLowerCase(),
        width: 0, height: 0, before: file.size, after: file.size
      });
    }

    return loadBitmap(file).then(function(src){
      var w = src.width, h = src.height;
      /* Cap the LONGEST edge, not the width. Capping width alone turns a
         portrait phone shot into a 1920x2560 monster that is heavier than the
         landscape version it was meant to match. */
      var scale = Math.min(1, maxEdge / Math.max(w, h));
      var tw = Math.max(1, Math.round(w * scale));
      var th = Math.max(1, Math.round(h * scale));

      var canvas = document.createElement('canvas');
      canvas.width = tw; canvas.height = th;
      var ctx = canvas.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';

      /* A transparent PNG re-encoded as JPEG goes black. Flatten onto white
         only when the target format has no alpha channel. */
      if(TARGET === 'image/jpeg'){
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, tw, th);
      }
      ctx.drawImage(src, 0, 0, tw, th);
      if(src.close) src.close();

      return new Promise(function(resolve){
        canvas.toBlob(function(blob){
          /* Re-encoding can occasionally produce a LARGER file than the
             original — a small, already-optimised PNG, say. Keep whichever
             is smaller, as long as we didn't need to resize. */
          if(!blob || (scale === 1 && blob.size >= file.size)){
            resolve({
              blob: file, type: file.type, ext: EXT[file.type] || 'jpg',
              width: w, height: h, before: file.size, after: file.size
            });
            return;
          }
          resolve({
            blob: blob, type: TARGET, ext: EXT[TARGET],
            width: tw, height: th, before: file.size, after: blob.size
          });
        }, TARGET, quality);
      });
    });
  }

  function fmtSize(bytes){
    if(bytes == null) return '';
    if(bytes < 1024) return bytes + ' B';
    if(bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' KB';
    return (bytes / 1048576).toFixed(1) + ' MB';
  }

  window.WBAmedia = { shrink: shrink, safeName: safeName, fmtSize: fmtSize, target: TARGET };
})();
