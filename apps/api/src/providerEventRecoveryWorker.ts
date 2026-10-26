import { getPool } from "./db.js";
import { queryDarajaStk, queryPesapalStatus } from "./providers.js";
import { getTenantProviderCredentials } from "./providerConnections.js";

type RetryEvent = {
  id: string;
  tenant_id: string;
  provider: "daraja" | "pesapal";
  provider_event_id: string;
  payload: Record<string, any>;
  transaction_id: string;
  amount_minor: string | number;
  currency: string;
  status: string;
};

async function recordReview(event: RetryEvent, reason: string) {
  await getPool().query(
    "insert into public.payment_reconciliation_exceptions(tenant_id,transaction_id,provider,provider_reference,exception_type,details) values($1,$2,$3,$4,'status_mismatch',$5::jsonb)",
    [event.tenant_id,event.transaction_id,event.provider,event.provider_event_id,JSON.stringify({reason})],
  );
}

/** Retry provider events that arrived before their transaction was correlated or whose provider query timed out. */
export async function processRetryableProviderEvents(batchSize = 10): Promise<{ processed: number; retried: number; exceptions: number }> {
  const counts = { processed: 0, retried: 0, exceptions: 0 };
  for (let i=0; i<Math.max(1,Math.min(50,batchSize)); i++) {
    const client=await getPool().connect();
    let event: RetryEvent | undefined;
    try {
      await client.query("begin");
      const selected=await client.query(
        `select e.id,e.tenant_id,e.provider,e.provider_event_id,e.payload,t.id as transaction_id,t.amount_minor,t.currency,t.status
         from public.payment_provider_events e
         join public.payment_transactions t on t.tenant_id=e.tenant_id and
           ((e.provider='daraja' and t.provider='daraja' and t.provider_checkout_request_id=e.provider_event_id) or
            (e.provider='pesapal' and t.provider='pesapal' and t.provider_order_tracking_id=e.provider_event_id))
         where ((e.processing_status='retry' and e.retry_at <= now()) or
           (e.processing_status='received' and e.processing_started_at < now()-interval '5 minutes'))
         order by e.received_at
         limit 1 for update of e skip locked`,
      );
      event=selected.rows[0];
      if (!event) { await client.query("commit"); break; }
      await client.query(
        "update public.payment_provider_events set processing_status='received',processing_attempts=processing_attempts+1,processing_started_at=now(),last_error=null where id=$1",
        [event.id],
      );
      await client.query("commit");
    } catch(error) {
      await client.query("rollback").catch(()=>undefined);
      throw error;
    } finally { client.release(); }

    try {
      if (event.provider === "daraja") {
        const callback=event.payload?.Body?.stkCallback;
        const items=callback?.CallbackMetadata?.Item;
        const amount=Array.isArray(items) ? Number(items.find((item:any)=>item.Name==="Amount")?.Value) : NaN;
        const receipt=Array.isArray(items) ? items.find((item:any)=>item.Name==="MpesaReceiptNumber")?.Value : undefined;
        const credentials = await getTenantProviderCredentials(event.tenant_id, "daraja") as Record<string, string>;
        const status=await queryDarajaStk(event.provider_event_id, credentials);
        const verified=String(status.ResultCode)==="0" && callback?.ResultCode===0 &&
          Number.isFinite(amount) && amount*100===Number(event.amount_minor) &&
          typeof receipt==="string" && receipt.length>0;
        if (verified) {
          const updated=await getPool().query(
            "update public.payment_transactions set status='succeeded',provider_receipt=$1,provider_status='status_query_verified_retry',confirmed_at=coalesce(confirmed_at,now()),updated_at=now() where id=$2 and tenant_id=$3 and status in ('created','pending','unknown')",
            [receipt,event.transaction_id,event.tenant_id],
          );
          if (!updated.rowCount) {
            await recordReview(event,"Provider success conflicts with an already-terminal ledger status.");
            counts.exceptions++;
          }
        } else {
          await recordReview(event,"Retried Daraja callback could not be independently verified.");
          counts.exceptions++;
        }
      } else {
        const credentials = await getTenantProviderCredentials(event.tenant_id, "pesapal") as Record<string, string>;
        const status=await queryPesapalStatus(event.provider_event_id, credentials);
        const code=Number(status.status_code);
        const amount=Number(status.amount);
        const currency=String(status.currency_code ?? status.currency ?? "").toUpperCase();
        const matches=Number.isFinite(amount) && Math.round(amount*100)===Number(event.amount_minor) &&
          currency===String(event.currency).trim().toUpperCase();
        if (matches && (code===1 || code===2)) {
          const outcome=code===1 ? "succeeded" : "failed";
          const updated=await getPool().query(
            "update public.payment_transactions set status=$1,provider_status=$2,confirmed_at=case when $1='succeeded' then coalesce(confirmed_at,now()) else confirmed_at end,updated_at=now() where id=$3 and tenant_id=$4 and status in ('created','pending','unknown')",
            [outcome,code===1 ? "pesapal_status_verified_retry" : "pesapal_status_verified_failed_retry",event.transaction_id,event.tenant_id],
          );
          if (!updated.rowCount) {
            await recordReview(event,"Pesapal terminal status conflicts with an already-terminal ledger status.");
            counts.exceptions++;
          }
        } else if (code===0) {
          await getPool().query(
            "update public.payment_provider_events set processing_status='retry',processing_started_at=null,retry_at=now()+interval '60 seconds',last_error='Provider payment is not terminal yet' where id=$1",
            [event.id],
          );
          counts.retried++;
          continue;
        } else {
          await recordReview(event,"Retried Pesapal status did not match the ledger amount and currency.");
          counts.exceptions++;
        }
      }
      await getPool().query(
        "update public.payment_provider_events set processing_status='processed',processed_at=now(),processing_started_at=null,last_error=null where id=$1",
        [event.id],
      );
      counts.processed++;
    } catch(error) {
      const message=(error instanceof Error ? error.message : "Unknown provider recovery error").slice(0,1000);
      await getPool().query(
        "update public.payment_provider_events set processing_status='retry',processing_started_at=null,retry_at=now()+interval '60 seconds',last_error=$2 where id=$1",
        [event.id,message],
      );
      counts.retried++;
    }
  }
  return counts;
}
