/* ==========================================================================
   WBA — Supabase client + data helpers.
   The publishable key is PUBLIC by design; row-level security is what
   actually protects the data. Load AFTER the supabase-js CDN script.

   Posts use two fields that drive the whole site:
     category  — the pillar: 'build' | 'create' | 'grow' (or '' for a plain note)
     featured  — pin this post to the pillar's slot on the home page
   Run supabase/schema.sql once to add `featured` if it isn't there yet.
   ========================================================================== */
(function(){
  var SUPABASE_URL = 'https://lynzhiyvggqyplssrapi.supabase.co';
  var SUPABASE_KEY = 'sb_publishable_j_RkzVTMyM-QtmFnLsf_Vw_ulanlx9K';

  if(!window.supabase || !window.supabase.createClient){
    console.warn('Supabase library not loaded — data features unavailable.');
    return;
  }
  var sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
  window.sbc = sb;
  /* Published so the portal can build its own client with different session
     storage — see the "Remember this device" note in js/portal.js. The key is
     public by design; this exposes nothing that is not already in this file. */
  window.sbcConfig = { url: SUPABASE_URL, key: SUPABASE_KEY };

  window.WBAdb = {
    /* ---------- public reads ---------- */
    listPosts: function(){
      return sb.from('posts')
        .select('slug,title,excerpt,cover_image,category,tags,featured,published_at')
        .eq('status', 'published')
        .order('published_at', { ascending: false });
    },
    getPost: function(slug){
      return sb.from('posts').select('*').eq('slug', slug).eq('status', 'published').single();
    },
    approvedSubs: function(type){
      var q = sb.from('submissions').select('*').eq('status', 'approved').order('reviewed_at', { ascending: false });
      if(type) q = q.eq('type', type);
      return q;
    },

    /* ---------- public write ---------- */
    submit: function(payload){ return sb.from('submissions').insert([payload]); },

    /* ---------- media library (admin) ----------------------------------
       Everything lives in the `media` bucket under posts/. Uploads are
       downscaled in the browser first: a phone or camera JPEG is routinely
       6-12MB, and shipping that to a visitor on mobile data undoes every
       other performance decision on the site. 1920px wide at q0.82 is
       indistinguishable on screen and usually 10-20x smaller.
       -------------------------------------------------------------------- */
    MEDIA_DIR: 'posts',

    uploadImage: function(file, opts){
      opts = opts || {};
      return WBAmedia.shrink(file, opts.maxEdge || 1920, opts.quality || 0.82)
        .then(function(out){
          var base = WBAmedia.safeName(file.name, out.ext);
          var path = 'posts/' + Date.now().toString(36) + '-' + base;
          return sb.storage.from('media')
            .upload(path, out.blob, { cacheControl: '31536000', upsert: false, contentType: out.type })
            .then(function(r){
              if(r.error) throw r.error;
              return sb.storage.from('media').getPublicUrl(path).data.publicUrl;
            });
        });
    },

    /* Newest first. Supabase returns name/created_at/metadata per object. */
    listMedia: function(limit, offset){
      return sb.storage.from('media').list('posts', {
        limit: limit || 100,
        offset: offset || 0,
        sortBy: { column: 'created_at', order: 'desc' }
      });
    },

    mediaUrl: function(name){
      return sb.storage.from('media').getPublicUrl('posts/' + name).data.publicUrl;
    },

    deleteMedia: function(name){
      return sb.storage.from('media').remove(['posts/' + name]);
    },

    /* ---------- auth ---------- */
    signIn: function(email, password){ return sb.auth.signInWithPassword({ email: email, password: password }); },
    signOut: function(){ return sb.auth.signOut(); },
    currentUser: function(){ return sb.auth.getUser(); },
    isAdmin: function(){ return sb.rpc('is_admin'); },

    /* ---------- admin: posts ----------------------------------------------
       IMPORTANT, and the source of a real bug worth remembering:

       When row-level security refuses an UPDATE or DELETE, PostgREST does NOT
       return an error. The USING clause simply matches no rows, so you get
       HTTP 200 and an empty array. Code that only checks `r.error` therefore
       reports "Saved" while nothing whatsoever has changed.

       Verified against the live API with the public key:
         PATCH /posts?id=eq.<id>  ->  200, []  and the row untouched.

       So every write here ends in .select(): the caller can then tell the
       difference between "saved" and "silently refused" by looking at how
       many rows came back. `wroteNothing()` below is that test.
       ---------------------------------------------------------------------- */
    allPosts: function(){ return sb.from('posts').select('*').order('updated_at', { ascending: false }); },
    savePost: function(p){
      var payload = Object.assign({}, p);
      payload.updated_at = new Date().toISOString();
      if(payload.status === 'published' && !payload.published_at) payload.published_at = new Date().toISOString();
      if(p.id){ delete payload.id; return sb.from('posts').update(payload).eq('id', p.id).select('id'); }
      delete payload.id;
      payload.id = wbaUUID();
      return sb.from('posts').insert([payload]).select('id');
    },
    deletePost: function(id){ return sb.from('posts').delete().eq('id', id).select('id'); },

    /* Only one post per pillar can hold the home-page slot. */
    clearFeatured: function(pillar, exceptId){
      var q = sb.from('posts').update({ featured: false }).eq('category', pillar).eq('featured', true);
      if(exceptId) q = q.neq('id', exceptId);
      return q;
    },

    /* ---------- admin: submissions ---------- */
    allSubs: function(){ return sb.from('submissions').select('*').order('created_at', { ascending: false }); },
    setSub: function(id, status){
      return sb.from('submissions').update({ status: status, reviewed_at: new Date().toISOString() }).eq('id', id).select('id');
    },
    deleteSub: function(id){ return sb.from('submissions').delete().eq('id', id).select('id'); },

    /* ---------- admin: clients ---------- */
    allClients: function(){ return sb.from('clients').select('*').order('created_at', { ascending: false }); },
    saveClient: function(c){
      var payload = Object.assign({}, c);
      payload.updated_at = new Date().toISOString();
      if(c.id){ delete payload.id; return sb.from('clients').update(payload).eq('id', c.id).select('id'); }
      delete payload.id;
      payload.id = wbaUUID();
      return sb.from('clients').insert([payload]).select('id');
    },
    deleteClient: function(id){ return sb.from('clients').delete().eq('id', id).select('id'); },

    /* ---------- page content (Edit mode) --------------------------------
       Read is public so the build can fetch overrides with the publishable
       key. Write is admin-only, enforced by RLS -- calling savePageContent
       from a signed-out console gets a 401, not a saved row.
       -------------------------------------------------------------------- */
    /* Takes a page path, or a list of them — edit mode asks for this page
       plus '*' (the nav and footer) in a single round trip. */
    getPageContent: function(page){
      var q = sb.from('page_content').select('page,key,value,kind,updated_at');
      return Array.isArray(page) ? q.in('page', page) : q.eq('page', page);
    },

    allPageContent: function(){
      return sb.from('page_content').select('*').order('updated_at', { ascending: false });
    },

    /* One round trip for the whole page. onConflict matches the unique index
       on (page, key), so re-editing the same line updates rather than piling
       up rows. updated_at/updated_by are set by a trigger, not by us -- the
       client does not get to say who made the change. */
    savePageContent: function(rows){
      return sb.from('page_content')
               .upsert(rows, { onConflict: 'page,key' })
               .select('key');
    },

    resetPageContent: function(page, key){
      return sb.from('page_content').delete().eq('page', page).eq('key', key).select('key');
    },

    /* ---------- admin: settings ---------- */
    getSetting: function(key){ return sb.from('settings').select('value').eq('key', key).maybeSingle(); },
    setSetting: function(key, value){
      return sb.from('settings').upsert({ key: key, value: value, updated_at: new Date().toISOString() }, { onConflict: 'key' }).select('key');
    }
  };
})();

/* Did that write actually change anything?

   Postgres row-level security refuses a write by matching zero rows, not by
   raising an error, so `!r.error` is not the same as "it worked". Pass any
   write result through this before telling somebody their work is saved. */
function wbaWroteNothing(r){
  return !!r && !r.error && Array.isArray(r.data) && r.data.length === 0;
}

/* UUID for new rows (works even if the database default is missing). */
function wbaUUID(){
  if(window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c){
    var r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

/* Title -> url-slug */
function wbaSlugify(s){
  return (s || '').toLowerCase().trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}
