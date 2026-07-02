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

    // ---------- auth ----------
    signIn: function(email, password){ return sb.auth.signInWithPassword({ email: email, password: password }); },
    signOut: function(){ return sb.auth.signOut(); },
    currentUser: function(){ return sb.auth.getUser(); },
    isAdmin: function(){ return sb.rpc('is_admin'); },

    // ---------- admin ----------
    allPosts: function(){ return sb.from('posts').select('*').order('updated_at', { ascending: false }); },
    savePost: function(p){
      p.updated_at = new Date().toISOString();
      if(p.status === 'published' && !p.published_at) p.published_at = new Date().toISOString();
      if(p.id){ var id = p.id; var copy = Object.assign({}, p); delete copy.id; return sb.from('posts').update(copy).eq('id', id); }
      return sb.from('posts').insert([p]);
    },
    deletePost: function(id){ return sb.from('posts').delete().eq('id', id); },
    allSubs: function(){ return sb.from('submissions').select('*').order('created_at', { ascending: false }); },
    setSub: function(id, status){
      return sb.from('submissions').update({ status: status, reviewed_at: new Date().toISOString() }).eq('id', id);
    }
  };
})();

/* Slugify helper (title -> url-slug) */
function wbaSlugify(s){
  return (s || '').toLowerCase().trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}
