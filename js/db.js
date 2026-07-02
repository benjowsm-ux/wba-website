/* ==========================================================================
   WBA — Supabase client + data helpers.
   The publishable key is PUBLIC by design (row-level security protects data).
   Load AFTER the supabase-js CDN script.
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

  window.WBAdb = {
    // ---------- public reads ----------
    listPosts: function(){
      return sb.from('posts')
        .select('slug,title,excerpt,cover_image,category,tags,published_at')
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
    // ---------- public write (submissions) ----------
    submit: function(payload){ return sb.from('submissions').insert([payload]); },

    // ---------- image upload (admin) -> permanent public URL ----------
    uploadImage: function(file){
      var ext = (((file.name || '').split('.').pop()) || 'png').toLowerCase().replace(/[^a-z0-9]/g, '') || 'png';
      var path = 'posts/' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.' + ext;
      return sb.storage.from('media').upload(path, file, { cacheControl: '3600', upsert: false }).then(function(r){
        if(r.error) throw r.error;
        return sb.storage.from('media').getPublicUrl(path).data.publicUrl;
      });
    },

    // ---------- auth ----------
    signIn: function(email, password){ return sb.auth.signInWithPassword({ email: email, password: password }); },
    signOut: function(){ return sb.auth.signOut(); },
    currentUser: function(){ return sb.auth.getUser(); },
    isAdmin: function(){ return sb.rpc('is_admin'); },

    // ---------- admin ----------
    allPosts: function(){ return sb.from('posts').select('*').order('updated_at', { ascending: false }); },
    savePost: function(p){
      var payload = Object.assign({}, p);
      payload.updated_at = new Date().toISOString();
      if(payload.status === 'published' && !payload.published_at) payload.published_at = new Date().toISOString();
      if(p.id){ delete payload.id; return sb.from('posts').update(payload).eq('id', p.id); }
      delete payload.id;
      payload.id = wbaUUID();               // generate an id for new posts
      return sb.from('posts').insert([payload]);
    },
    deletePost: function(id){ return sb.from('posts').delete().eq('id', id); },
    allSubs: function(){ return sb.from('submissions').select('*').order('created_at', { ascending: false }); },
    setSub: function(id, status){
      return sb.from('submissions').update({ status: status, reviewed_at: new Date().toISOString() }).eq('id', id);
    }
  };
})();

/* UUID for new posts (works even if the DB default is missing) */
function wbaUUID(){
  if(window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c){ var r=Math.random()*16|0, v=c==='x'?r:(r&0x3|0x8); return v.toString(16); });
}

/* Slugify helper (title -> url-slug) */
function wbaSlugify(s){
  return (s || '').toLowerCase().trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}
