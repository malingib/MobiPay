-- Verify the least-privilege runtime role in disposable PostgreSQL.
begin;
set local role mobipay_runtime;
do $assertions$
declare
  role_row record;
  owned_tables integer;
begin
  select rolsuper,rolbypassrls,rolcanlogin into role_row
    from pg_roles where rolname=current_user;
  if role_row.rolsuper or role_row.rolbypassrls or role_row.rolcanlogin then
    raise exception 'mobipay_runtime must be NOLOGIN, NOSUPERUSER and NOBYPASSRLS';
  end if;
  if not has_table_privilege(current_user,'public.payment_transactions','SELECT')
     or not has_table_privilege(current_user,'public.payment_transactions','INSERT')
     or not has_table_privilege(current_user,'public.payment_transactions','UPDATE') then
    raise exception 'mobipay_runtime is missing required payment transaction privileges';
  end if;
  if has_table_privilege(current_user,'public.payment_transactions','DELETE') then
    raise exception 'mobipay_runtime must not have DELETE privilege';
  end if;
  select count(*) into owned_tables
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relkind in ('r','p')
      and c.relname like 'payment\_%' escape '\' and c.relowner=(select oid from pg_roles where rolname=current_user);
  if owned_tables<>0 then raise exception 'mobipay_runtime must not own payment tables'; end if;
end;
$assertions$;
rollback;
