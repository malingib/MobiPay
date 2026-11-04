import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";

const connectionString = process.env.TEST_DATABASE_URL;
test("PostgreSQL callback correlation is tenant-scoped and duplicate events are idempotent", { skip: !connectionString }, async () => {
  const pool = new pg.Pool({ connectionString });
  const tenantA = (await pool.query("insert into public.payment_tenants(name,slug) values('callback-a',$1) returning id", ["callback-a-"+crypto.randomUUID().replaceAll("-","")])).rows[0].id as string;
  const tenantB = (await pool.query("insert into public.payment_tenants(name,slug) values('callback-b',$1) returning id", ["callback-b-"+crypto.randomUUID().replaceAll("-","")])).rows[0].id as string;
  try {
    await pool.query(
      "insert into public.payment_transactions(tenant_id,provider,provider_checkout_request_id,merchant_reference,amount_minor,currency,status) values($1,'daraja','shared-checkout-id','ref-a',100,'KES','pending')",
      [tenantA],
    );
    const crossTenant = await pool.query(
      "select id from public.payment_transactions where tenant_id=$1 and provider='daraja' and provider_checkout_request_id=$2",
      [tenantB,"shared-checkout-id"],
    );
    assert.equal(crossTenant.rowCount,0);
    const insert = "insert into public.payment_provider_events(tenant_id,provider,provider_event_id,event_type,payload_sha256,payload,processing_status) values($1,'daraja','shared-checkout-id','stk_callback',$2,'{}'::jsonb,'retry') on conflict(tenant_id,provider,provider_event_id) do nothing";
    const hash = "a".repeat(64);
    assert.equal((await pool.query(insert,[tenantA,hash])).rowCount,1);
    assert.equal((await pool.query(insert,[tenantA,hash])).rowCount,0);
    const events = await pool.query("select count(*)::int as count from public.payment_provider_events where tenant_id=$1 and provider='daraja' and provider_event_id='shared-checkout-id'",[tenantA]);
    assert.equal(events.rows[0].count,1);
    assert.equal((await pool.query("update public.payment_transactions set status='succeeded' where tenant_id=$1 and provider_checkout_request_id=$2",[tenantB,"shared-checkout-id"])).rowCount,0);
  } finally {
    await pool.query("delete from public.payment_provider_events where tenant_id=any($1::uuid[])",[[tenantA,tenantB]]);
    await pool.query("delete from public.payment_transactions where tenant_id=any($1::uuid[])",[[tenantA,tenantB]]);
    await pool.query("delete from public.payment_tenants where id=any($1::uuid[])",[[tenantA,tenantB]]);
    await pool.end();
  }
});

test("PostgreSQL SKIP LOCKED claims exclude a competing worker and stale leases cannot complete", { skip: !connectionString }, async () => {
  const pool = new pg.Pool({ connectionString, max: 4 });
  const slug = "worker-"+crypto.randomUUID().replaceAll("-","");
  const tenant = (await pool.query("insert into public.payment_tenants(name,slug) values('worker test',$1) returning id",[slug])).rows[0].id as string;
  const endpoint = (await pool.query("insert into public.payment_merchant_webhook_endpoints(tenant_id,url,signing_secret_reference,enabled) values($1,'https://example.test/hook','TEST_WEBHOOK_SECRET',true) returning id",[tenant])).rows[0].id as string;
  const delivery = (await pool.query("insert into public.payment_merchant_webhook_deliveries(tenant_id,endpoint_id,event_id,event_type,payload,status) values($1,$2,$3,'payment.succeeded','{}'::jsonb,'pending') returning id",[tenant,endpoint,crypto.randomUUID()])).rows[0].id as string;
  const first = await pool.connect(), second = await pool.connect();
  const firstLease = crypto.randomUUID(), staleLease = crypto.randomUUID();
  try {
    await first.query("begin");
    const claim1 = await first.query("select id from public.payment_merchant_webhook_deliveries where id=$1 for update skip locked",[delivery]);
    assert.equal(claim1.rowCount,1);
    await second.query("begin");
    const claim2 = await second.query("select id from public.payment_merchant_webhook_deliveries where id=$1 for update skip locked",[delivery]);
    assert.equal(claim2.rowCount,0);
    await first.query("update public.payment_merchant_webhook_deliveries set status='delivering',claim_token=$2,lease_expires_at=now()+interval '2 minutes' where id=$1",[delivery,firstLease]);
    await first.query("commit");
    const stale = await second.query("update public.payment_merchant_webhook_deliveries set status='delivered' where id=$1 and claim_token=$2",[delivery,staleLease]);
    assert.equal(stale.rowCount,0);
    await second.query("commit");
    const owner = await pool.query("update public.payment_merchant_webhook_deliveries set status='delivered',claim_token=null,lease_expires_at=null where id=$1 and claim_token=$2",[delivery,firstLease]);
    assert.equal(owner.rowCount,1);
  } finally {
    await first.query("rollback").catch(()=>undefined);
    await second.query("rollback").catch(()=>undefined);
    first.release(); second.release();
    await pool.query("delete from public.payment_merchant_webhook_deliveries where id=$1",[delivery]);
    await pool.query("delete from public.payment_merchant_webhook_endpoints where id=$1",[endpoint]);
    await pool.query("delete from public.payment_tenants where id=$1",[tenant]);
    await pool.end();
  }
});
