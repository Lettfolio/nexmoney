-- =============================================================================
-- R93 · 01 · site_pages / site_posts / site_publishes / seo_snapshots — the Website page
--
-- WHAT: the four tables behind the back office's Website page (Content + SEO tabs), their RLS,
--       grants, the updated_at touch trigger, the site_posts status guard, and three settings
--       rows (insert … on conflict do nothing — a value already set by hand is never overwritten):
--         vercel_deploy_hook_secret ''  ·  gsc_property 'sc-domain:nexmoney.co.uk'  ·  seo_audit_enabled 'on'
--       The hook key carries "secret" so the R84 "settings read staff" regex hides it from non-owners
--       (a deploy hook is a bearer capability); admins learn only whether it is set via
--       site_hook_is_set().
-- WHO:  owner/admin (is_admin_or_owner(), which carries session_ok() since R86) on site_pages /
--       site_posts; SELECT only on site_publishes / seo_snapshots (the edge functions write them
--       as service_role). No DELETE on site_publishes or seo_snapshots (no policy AND no grant).
--       anon may SELECT site_pages and PUBLISHED site_posts — build.js reads them with the public
--       anon key at deploy time. anon's SELECT is COLUMN-scoped: site_pages.notes/updated_by and
--       site_posts.author_id/approved_by/approved_at are internal and are not granted to anon, so
--       build.js names its columns (a `select=*` as anon is a 42501 by design).
-- STATUS GUARD (trigger site_posts_status_guard, BEFORE INSERT OR UPDATE on site_posts):
--       moving a post INTO 'approved' or 'published' needs is_owner() (42501 "Only the owner can
--       approve"); approved stamps approved_by/approved_at; published stamps published_at if null.
--       A non-owner edit of title/slug/excerpt/body_md/cover_image on an approved or published post
--       demotes it to 'draft' and clears the approval stamps (no exception) — the owner's approval
--       never vouches for words the owner did not see.
--       Enforced only for the API roles (anon/authenticated) — the SQL editor and service_role
--       are not end users.
-- IDEMPOTENT: create … if not exists / create or replace / drop policy if exists.
-- DRY RUN: wrapped in BEGIN/COMMIT — replace the final COMMIT with ROLLBACK.
-- VERIFY (after apply):
--   select relname, relrowsecurity from pg_class where relnamespace='public'::regnamespace
--      and relname in ('site_pages','site_posts','site_publishes','seo_snapshots');       -- 4 rows, all t
--   select tablename, policyname, cmd, roles from pg_policies
--    where tablename in ('site_pages','site_posts','site_publishes','seo_snapshots') order by 1,2;
--     -- site_pages: admin all + anon read · site_posts: admin all + anon read published
--     -- site_publishes / seo_snapshots: admin select only (service_role writes)
--   select has_table_privilege('authenticated','public.seo_snapshots','DELETE');           -- f
--   select has_column_privilege('anon','public.site_pages','notes','SELECT');              -- f
--   select key, value from settings where key in ('vercel_deploy_hook_secret','gsc_property','seo_audit_enabled');
-- =============================================================================
begin;

-- ---------- tables (shape frozen by R93-CONTRACT.md)
create table if not exists public.site_pages (
  slug             text primary key check (slug ~ '^[a-z0-9-]*$'),
  title            text,
  meta_description text,
  og_title         text, og_description text, og_image text,
  h1               text,
  faq              jsonb not null default '[]',
  notes            text,
  updated_at       timestamptz not null default now(),
  updated_by       uuid references auth.users(id)
);

create table if not exists public.site_posts (
  id           uuid primary key default gen_random_uuid(),
  slug         text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  title        text not null,
  excerpt      text,
  body_md      text not null default '',
  cover_image  text,
  status       text not null default 'draft' check (status in ('draft','approved','published','archived')),
  approved_by  uuid references auth.users(id), approved_at timestamptz,
  published_at timestamptz,
  author_id    uuid references auth.users(id),
  created_at   timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table if not exists public.site_publishes (
  id           uuid primary key default gen_random_uuid(),
  requested_by uuid references auth.users(id), requested_at timestamptz not null default now(),
  status       text not null default 'requested' check (status in ('requested','sent','failed')),
  detail       text,
  pages        int, posts int
);

create table if not exists public.seo_snapshots (
  id         bigserial primary key,
  day        date not null default (now() at time zone 'utc')::date,
  kind       text not null check (kind in ('audit','psi','gsc','gsc_query','summary')),
  page       text not null default '',
  data       jsonb not null default '{}',
  created_at timestamptz not null default now(),
  unique (day, kind, page)
);

-- R93: the SEO tab reads "latest day" and the build reads published posts — both are index-led.
create index if not exists site_posts_status_idx on public.site_posts (status);
create index if not exists seo_snapshots_day_idx on public.seo_snapshots (day desc);

-- ---------- updated_at (no generic set_updated_at() exists in the live snapshot; touch_* are per-table)
create or replace function public.site_touch_updated_at()
 returns trigger
 language plpgsql
 set search_path to ''
as $function$ begin new.updated_at := now(); return new; end $function$;

drop trigger if exists site_pages_touch on public.site_pages;
create trigger site_pages_touch before update on public.site_pages
  for each row execute function public.site_touch_updated_at();
drop trigger if exists site_posts_touch on public.site_posts;
create trigger site_posts_touch before update on public.site_posts
  for each row execute function public.site_touch_updated_at();

-- ---------- server-side author stamps (R93 · fixer: never trust a client-supplied uuid)
create or replace function public.site_pages_stamp_author()
 returns trigger
 language plpgsql
 set search_path to ''
as $function$ begin new.updated_by := auth.uid(); return new; end $function$;

drop trigger if exists site_pages_stamp_author on public.site_pages;
create trigger site_pages_stamp_author before insert or update on public.site_pages
  for each row execute function public.site_pages_stamp_author();

create or replace function public.site_posts_stamp_author()
 returns trigger
 language plpgsql
 set search_path to ''
as $function$ begin new.author_id := coalesce(new.author_id, auth.uid()); return new; end $function$;

drop trigger if exists site_posts_stamp_author on public.site_posts;
create trigger site_posts_stamp_author before insert on public.site_posts
  for each row execute function public.site_posts_stamp_author();

-- ---------- status guard: only the owner approves / publishes
create or replace function public.site_posts_status_guard()
 returns trigger
 language plpgsql
 set search_path to 'public'
as $function$
begin
  -- R93 · fixer: a non-owner edit of approved/published content demotes it — approval covers exact words
  if tg_op = 'UPDATE' and current_user in ('authenticated', 'anon') and not public.is_owner()
     and old.status in ('approved', 'published')
     and (new.title is distinct from old.title or new.slug is distinct from old.slug
          or new.excerpt is distinct from old.excerpt or new.body_md is distinct from old.body_md
          or new.cover_image is distinct from old.cover_image) then
    new.status := 'draft';
    new.approved_by := null;
    new.approved_at := null;
    new.published_at := null;
  end if;
  if new.status in ('approved', 'published')
     and (tg_op = 'INSERT' or new.status is distinct from old.status) then
    -- R93: API roles only; postgres / service_role (SQL editor, edge functions) are not end users
    if current_user in ('authenticated', 'anon') and not public.is_owner() then
      raise exception 'Only the owner can approve' using errcode = '42501';
    end if;
    if new.status = 'approved' then
      new.approved_by := auth.uid();
      new.approved_at := now();
    end if;
  end if;
  if new.status = 'published' and new.published_at is null then
    new.published_at := now();
  end if;
  return new;
end
$function$;

drop trigger if exists site_posts_status_guard on public.site_posts;
create trigger site_posts_status_guard before insert or update on public.site_posts
  for each row execute function public.site_posts_status_guard();

-- ---------- RLS
alter table public.site_pages     enable row level security;
alter table public.site_posts     enable row level security;
alter table public.site_publishes enable row level security;
alter table public.seo_snapshots  enable row level security;

drop policy if exists "site_pages admin all" on public.site_pages;
create policy "site_pages admin all" on public.site_pages for all to authenticated
  using ((select public.is_admin_or_owner())) with check ((select public.is_admin_or_owner()));
drop policy if exists "site_pages anon read" on public.site_pages;
create policy "site_pages anon read" on public.site_pages for select to anon
  using (true);

drop policy if exists "site_posts admin all" on public.site_posts;
create policy "site_posts admin all" on public.site_posts for all to authenticated
  using ((select public.is_admin_or_owner())) with check ((select public.is_admin_or_owner()));
drop policy if exists "site_posts anon read published" on public.site_posts;
create policy "site_posts anon read published" on public.site_posts for select to anon
  using (status = 'published');

drop policy if exists "site_publishes admin read" on public.site_publishes;
create policy "site_publishes admin read" on public.site_publishes for select to authenticated
  using ((select public.is_admin_or_owner()));
-- R93 · fixer: the edge functions write these as service_role; the UI only reads
drop policy if exists "site_publishes admin insert" on public.site_publishes;
drop policy if exists "site_publishes admin update" on public.site_publishes;

drop policy if exists "seo_snapshots admin read" on public.seo_snapshots;
create policy "seo_snapshots admin read" on public.seo_snapshots for select to authenticated
  using ((select public.is_admin_or_owner()));
drop policy if exists "seo_snapshots admin insert" on public.seo_snapshots;
drop policy if exists "seo_snapshots admin update" on public.seo_snapshots;

-- ---------- grants (start from nothing for the API roles, then add exactly what the policies allow)
revoke all on table public.site_pages, public.site_posts, public.site_publishes, public.seo_snapshots
  from anon, authenticated;

grant select, insert, update, delete on table public.site_pages, public.site_posts to authenticated;
grant select on table public.site_publishes, public.seo_snapshots to authenticated;

-- R93: anon (the build) reads published content only, never the internal columns
grant select (slug, title, meta_description, og_title, og_description, og_image, h1, faq, updated_at)
  on table public.site_pages to anon;
grant select (id, slug, title, excerpt, body_md, cover_image, status, published_at, created_at, updated_at)
  on table public.site_posts to anon;

grant select, insert, update, delete on table public.site_pages, public.site_posts,
  public.site_publishes, public.seo_snapshots to service_role;
grant usage, select on sequence public.seo_snapshots_id_seq to service_role;

revoke all on function public.site_touch_updated_at() from public, anon;
revoke all on function public.site_posts_status_guard() from public, anon;
revoke all on function public.site_pages_stamp_author() from public, anon;
revoke all on function public.site_posts_stamp_author() from public, anon;

-- ---------- is the deploy hook set? (the key itself is owner-only under "settings read staff")
create or replace function public.site_hook_is_set()
 returns boolean
 language sql
 stable
 security definer
 set search_path = public
as $function$
  select public.session_ok() and public.is_admin_or_owner()
     and coalesce((select value from public.settings where key = 'vercel_deploy_hook_secret'), '') <> ''
$function$;
revoke all on function public.site_hook_is_set() from public, anon;
grant execute on function public.site_hook_is_set() to authenticated;

-- ---------- settings rows (never overwrite a value already set)
insert into public.settings (key, value) values
  ('vercel_deploy_hook_secret', ''),
  ('gsc_property', 'sc-domain:nexmoney.co.uk'),
  ('seo_audit_enabled', 'on')
on conflict (key) do nothing;

commit;
