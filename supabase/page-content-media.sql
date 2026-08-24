-- ==========================================================================
-- WBA — extend Edit mode from text to images and link destinations.
--
-- Run supabase/page-content.sql FIRST. Safe to re-run.
--
-- Two new `kind` values join 'text' and 'rich':
--
--   'src'   an image. value is JSON: {"src":"...","w":1600,"h":900,"alt":"..."}
--           The dimensions ride along so the build can keep width/height on
--           the tag -- without them the page reflows while the image loads.
--
--   'href'  a link or button destination. value is the URL.
--
-- Both are validated again at build time against an allow-list. Nothing in
-- this table is trusted just because it is in this table.
-- ==========================================================================

alter table public.page_content drop constraint if exists page_content_sane;
alter table public.page_content add constraint page_content_sane check (
  length(page)  between 1 and 200
  and length(key)   between 1 and 120
  and length(value) <= 20000
  and kind in ('text', 'rich', 'src', 'href')
);

-- ==========================================================================
-- Checking it worked
-- --------------------------------------------------------------------------
--   insert into public.page_content(page,key,value,kind)
--   values ('/','probe','/photos/x.jpg','src');
--   -> succeeds (as an admin), and
--   delete from public.page_content where key = 'probe';
--
--   insert into public.page_content(page,key,value,kind)
--   values ('/','probe','x','nonsense');
--   -> violates check constraint "page_content_sane"
-- ==========================================================================
