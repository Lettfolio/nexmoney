-- =============================================================================
-- 20261103163000_r97_red_team — R97 · S (SQL slice of the R97 red-team fixes; contract R97-VERIFY.md §3 "S · SQL")
--
-- Applied to PRODUCTION by the Supabase GitHub integration when the PR merges (supabase/README.md).
-- Daniel does NOT paste it. Idempotent: drop … if exists / create or replace / guarded updates.
-- Owner decisions (3 Nov 2026): D1 adviser MFA = YES · D2 drop "cases delete admin" = YES · D3 = NO (S-9 out).
--
--   S-1 (sql-1)  vault_entries "staff update vault" + "staff insert vault" WITH CHECK: a non-owner can never
--                write a row the Owner cannot see (restricted rows must name 'owner' and the writer's role).
--   S-2 (sql-2)  audit_vault_row(): every field VALUE → '(hidden)' (labels kept); visible_to recorded in changes.
--   S-3 (sql-2)  "audit read" on audit_log: vault_entries joins settings/profiles as Owner-only.
--   S-4 (sql-3)  guard_email_queue_status() BEFORE UPDATE OR DELETE on email_queue: a signed-in caller cannot
--                mark a row sent/sending, rewrite a sent row's status/sent_at, or delete a sent/sending row.
--                The sender (service role, auth.uid() null) is untouched.
--   S-5 (sql-9)  guard_role_change(): non-owners cannot change profiles.full_name / profiles.email.
--   S-6 (sql-5)  drop the unused "staff client-docs update" storage policy.
--   S-7 (live)   anon loses every table grant in public; it keeps only the R93 column-level SELECT on
--                site_pages / site_posts (when those tables exist — they come from db/r93, not this folder,
--                so a Preview Branch skips them). Default privileges for new tables no longer grant anon.
--   S-8 (sql-7)  drop "cases delete admin": no UI deletes a case; client delete/merge still works (FK cascade
--                bypasses RLS).
--   D1           settings.mfa_enforced_roles gains 'adviser' (appended, so whatever else is listed is kept;
--                an EMPTY value — the R86 break-glass — is left empty on purpose).
-- =============================================================================

-- ---------- S-1 · vault write predicate --------------------------------------------------------
drop policy if exists "staff update vault" on public.vault_entries;
create policy "staff update vault" on public.vault_entries
  for update to public
  using ((select public.is_staff())
         and (visible_to is null or cardinality(visible_to) = 0 or (select public.my_role()) = any (visible_to)))
  with check ((select public.is_staff())
         and ((select public.is_owner())
              or visible_to is null or cardinality(visible_to) = 0
              or ('owner' = any (visible_to) and (select public.my_role()) = any (visible_to))));
drop policy if exists "staff insert vault" on public.vault_entries;
create policy "staff insert vault" on public.vault_entries for insert to public
  with check ((select public.is_staff())
         and ((select public.is_owner())
              or visible_to is null or cardinality(visible_to) = 0
              or ('owner' = any (visible_to) and (select public.my_role()) = any (visible_to))));

-- ---------- S-2 · audit_vault_row hides every value ------------------------------------------
CREATE OR REPLACE FUNCTION public.audit_vault_row()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  redact jsonb;
  actor_label text;
begin
  select coalesce(full_name, email) into actor_label from profiles where id = auth.uid();
  if actor_label is null then actor_label := 'System / import'; end if;
  -- R97 · S-2: no field value reaches audit_log, flagged secret or not (labels only).
  redact := (
    select coalesce(jsonb_agg(jsonb_build_object('label', f->>'label', 'value', '(hidden)')), '[]'::jsonb)
    from jsonb_array_elements(coalesce(case when TG_OP='DELETE' then OLD.fields else NEW.fields end, '[]'::jsonb)) f
  );
  insert into audit_log (actor, actor_label, action, table_name, row_id, summary, changes)
  values (
    auth.uid(), actor_label,
    lower(TG_OP), 'vault_entries',
    coalesce(NEW.id, OLD.id)::text,
    coalesce(NEW.name, OLD.name) || ' (' || coalesce(NEW.category, OLD.category) || ')',
    jsonb_build_object('name', coalesce(NEW.name, OLD.name),
                       'owner', coalesce(NEW.owner_label, OLD.owner_label),
                       'visible_to', to_jsonb(case when TG_OP='DELETE' then OLD.visible_to else NEW.visible_to end),
                       'fields', redact)
  );
  return coalesce(NEW, OLD);
end $function$;
revoke execute on function public.audit_vault_row() from public, anon, authenticated;

-- ---------- S-3 · audit_log: vault rows are Owner-only ---------------------------------------
drop policy if exists "audit read" on public.audit_log;
create policy "audit read" on public.audit_log for select to public
  using (case when table_name = any (array['settings'::text,'profiles'::text,'vault_entries'::text])
              then (select public.is_owner())
              else (select public.is_staff()) end);

-- ---------- S-4 · email_queue: only the sender marks a row sent ------------------------------
create or replace function public.guard_email_queue_status() returns trigger
language plpgsql security definer set search_path to 'public' as $$
begin
  -- R97 · sql-3: only the sender (service role, auth.uid() is null) may mark a row sent/sending or remove a row that is not queued/failed.
  if auth.uid() is not null then
    if tg_op = 'UPDATE' and new.status in ('sent','sending') and new.status is distinct from old.status then
      raise exception 'email_queue: only the sender may mark a row as %', new.status using errcode = '42501';
    end if;
    if tg_op = 'UPDATE' and old.status = 'sent' and (new.status is distinct from old.status or new.sent_at is distinct from old.sent_at) then
      raise exception 'email_queue: a sent row is read-only' using errcode = '42501';
    end if;
    if tg_op = 'DELETE' and old.status not in ('queued','failed','cancelled') then
      raise exception 'email_queue: a sent row cannot be deleted' using errcode = '42501';
    end if;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
revoke execute on function public.guard_email_queue_status() from public, anon, authenticated;
drop trigger if exists email_queue_status_guard on public.email_queue;
create trigger email_queue_status_guard before update or delete on public.email_queue
  for each row execute function public.guard_email_queue_status();

-- ---------- S-5 · guard_role_change: names and emails are Owner-edited -----------------------
CREATE OR REPLACE FUNCTION public.guard_role_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if tg_op = 'UPDATE' and new.role is distinct from old.role then
    if auth.uid() is not null and not is_owner() then
      raise exception 'Only an Owner can change a role';
    end if;
  end if;

  -- R11 BE-2: an introducer login must not be able to repoint itself at a
  -- different introducer (tenant isolation).
  if tg_op = 'UPDATE' and new.introducer_id is distinct from old.introducer_id then
    if auth.uid() is not null and not is_owner() then
      raise exception 'Only an Owner can change which introducer a login belongs to';
    end if;
  end if;

  -- R97 · S-5: audit_log labels actors by full_name/email, so only the Owner may change them.
  if tg_op = 'UPDATE' and (new.full_name is distinct from old.full_name or new.email is distinct from old.email) then
    if auth.uid() is not null and not is_owner() then
      raise exception 'Only an Owner can change a name or email' using errcode = '42501';
    end if;
  end if;

  if (tg_op = 'UPDATE' and old.role = 'owner' and new.role is distinct from 'owner')
     or (tg_op = 'DELETE' and old.role = 'owner') then
    if (select count(*) from profiles where role = 'owner') <= 1 then
      raise exception 'Cannot remove the last Owner — promote someone else first';
    end if;
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end
$function$;
revoke execute on function public.guard_role_change() from public, anon, authenticated;

-- ---------- S-6 · storage: drop the unused client-docs UPDATE policy -------------------------
drop policy if exists "staff client-docs update" on storage.objects;

-- ---------- S-7 · anon: no table grants beyond the R93 public-site columns -------------------
revoke all on all tables in schema public from anon;
alter default privileges for role postgres in schema public revoke all on tables from anon;
do $$
begin
  -- R97 · S-7: same column lists as db/r93/01_site_tables.sql (the build reads these; nothing else).
  if to_regclass('public.site_pages') is not null then
    grant select (slug, title, meta_description, og_title, og_description, og_image, h1, faq, updated_at)
      on table public.site_pages to anon;
  end if;
  if to_regclass('public.site_posts') is not null then
    grant select (id, slug, title, excerpt, body_md, cover_image, status, published_at, created_at, updated_at)
      on table public.site_posts to anon;
  end if;
end $$;

-- ---------- S-8 · no case deletion through the API -------------------------------------------
drop policy if exists "cases delete admin" on public.cases;

-- ---------- D1 · advisers need the second factor too -----------------------------------------
update public.settings
   set value = btrim(value) || ',adviser'
 where key = 'mfa_enforced_roles'
   and btrim(value) <> ''
   and value !~* '(^|,)\s*adviser\s*(,|$)';

-- =============================================================================
-- VERIFY (run after the merge; expected results on the right)
--   select polname, pg_get_expr(polwithcheck, polrelid) from pg_policy
--    where polrelid = 'public.vault_entries'::regclass and polname in ('staff update vault','staff insert vault');
--                                                        -- both checks contain "'owner'::text = ANY (visible_to)"
--   select prosrc ~ '''value'', ''\(hidden\)''\)\)' as all_hidden, prosrc like '%visible_to%' as logs_vt
--     from pg_proc where proname = 'audit_vault_row';   -- t | t
--   select pg_get_expr(polqual, polrelid) from pg_policy where polname = 'audit read';
--                                                        -- array includes 'vault_entries'
--   select tgname from pg_trigger where tgrelid = 'public.email_queue'::regclass and not tgisinternal;
--                                                        -- includes email_queue_status_guard
--   select prosrc like '%full_name%' from pg_proc where proname = 'guard_role_change';   -- t
--   select count(*) from pg_policies where schemaname = 'storage' and policyname = 'staff client-docs update';  -- 0
--   select count(*) from pg_policies where schemaname = 'public' and policyname = 'cases delete admin';        -- 0
--   select table_name, privilege_type from information_schema.role_table_grants
--    where grantee = 'anon' and table_schema = 'public';                                -- 0 rows
--   select distinct table_name from information_schema.column_privileges
--    where grantee = 'anon' and table_schema = 'public';                                -- site_pages, site_posts
--   select defaclacl from pg_default_acl where defaclrole = 'postgres'::regrole
--     and defaclnamespace = 'public'::regnamespace and defaclobjtype = 'r';             -- no "anon=" entry
--   select value from settings where key = 'mfa_enforced_roles';                         -- owner,admin,adviser
-- =============================================================================
