-- Read-only tenant-isolation diagnostic. Run as the same role used by the API.
-- This script does not mutate data or change role/table security settings.

-- 1. The connected API role must not own tenant tables or bypass RLS.
select
  current_user as connected_role,
  r.rolsuper as is_superuser,
  r.rolbypassrls as bypasses_rls,
  count(distinct c.oid) filter (where c.relowner = r.oid) as tenant_tables_owned_by_runtime_role
from pg_roles r
left join pg_class c
  on c.relnamespace = 'public'::regnamespace
 and c.relkind in ('r','p')
 and c.relname like 'payment\_%' escape '\'
where r.rolname = current_user
group by r.rolsuper, r.rolbypassrls;

-- 2. Every tenant-bearing payment table must have RLS enabled and eventually forced.
select
  c.relname as table_name,
  c.relrowsecurity as rls_enabled,
  c.relforcerowsecurity as force_rls,
  pg_get_userbyid(c.relowner) as table_owner
from pg_class c
join pg_attribute a on a.attrelid = c.oid and a.attname = 'tenant_id'
where c.relnamespace = 'public'::regnamespace
  and c.relkind in ('r','p')
  and a.attnum > 0 and not a.attisdropped
  and c.relname like 'payment\_%' escape '\'
order by c.relname;

-- 3. List policies and commands; empty/SELECT-only policies cannot support
-- a NOBYPASSRLS runtime API that must write payment state.
select
  schemaname, tablename, policyname, permissive, roles, cmd,
  qual, with_check
from pg_policies
where schemaname = 'public'
  and tablename like 'payment\_%' escape '\'
order by tablename, policyname;

-- 4. Inspect SECURITY DEFINER functions and owners. Review every result before
-- enabling FORCE RLS; privileged functions need fixed search_path and narrow grants.
select
  p.oid::regprocedure as function_name,
  pg_get_userbyid(p.proowner) as function_owner,
  p.prosecdef as security_definer,
  p.proconfig as function_settings
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname like '%payment%'
order by p.proname;
