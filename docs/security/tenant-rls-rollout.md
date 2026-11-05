# Tenant RLS rollout diagnostics

Run `neon/tests/tenant_rls_audit.sql` using the exact database role configured for
the API, first on a disposable Neon branch and later as a read-only production
verification step.

The report identifies:
- runtime superuser / BYPASSRLS flags and tenant-table ownership;
- tenant-bearing tables without RLS or FORCE RLS;
- policies that are SELECT-only and therefore incompatible with a write-capable
  NOBYPASSRLS API role;
- SECURITY DEFINER payment functions and their owners/settings.

## Rollout rule

Do not promote the API to a NOBYPASSRLS role until every merchant route and
background path is covered by transaction-local identity context or a
purpose-built, narrowly granted database function. The role must not own
tenant tables, be a superuser, or have BYPASSRLS. Migrations must run under a
separate owner role.

The current policies are not yet a complete runtime-role policy set. In
particular, callback and worker paths must not impersonate a merchant by
accepting a tenant ID from a public request. They need narrowly scoped
provider-event / worker capabilities with verified callback credentials and
least-privilege SQL.

Do not apply role changes, grants, or FORCE RLS to the production Neon branch
until this report and the full two-merchant API attack suite pass on a
disposable branch.
