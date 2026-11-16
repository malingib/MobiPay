import { queryDarajaStk, queryPesapalStatus, verifyPaystackTransaction } from "./providers.js";
import { getTenantProviderCredentials } from "./providerConnections.js";
import { issuePaymentWorkerCapability, newLeaseToken, withPaymentWorkerTransaction } from "./systemDb.js";

type RetryEvent = {
  id: string; tenant_id: string; provider: "daraja" | "pesapal" | "paystack"; provider_event_id: string;
  processing_attempts: number; payload: Record<string, any>; transaction_id: string | null; amount_minor: string | number | null;
  currency: string | null; status: string | null; claim_token: string;
};

async function retryOwnedEvent(event: RetryEvent, message: string) {
  const cap = issuePaymentWorkerCapability();
  await withPaymentWorkerTransaction(cap, async (client) => {
    const attempts = Number(event.processing_attempts) + 1;
    if (attempts >= 10) {
      const owned = await client.query(
        "update public.payment_provider_events set processing_status='rejected',processing_started_at=null,claim_token=null,lease_expires_at=null,last_error=$3 where id=$1 and tenant_id=$2 and claim_token=$4 returning id",
        [event.id,event.tenant_id,message.slice(0,1000),event.claim_token],
      );
      if (owned.rowCount) {
        await client.query(
          "insert into public.payment_reconciliation_exceptions(tenant_id,provider,provider_reference,exception_type,details) values($1,$2,$3,'other',$4::jsonb)",
          [event.tenant_id,event.provider,event.provider_event_id,JSON.stringify({reason:"Provider callback recovery exhausted its retry budget.",lastError:message.slice(0,500)})],
        );
      }
      return;
    }
    await client.query(
      "update public.payment_provider_events set processing_status='retry',processing_started_at=null,claim_token=null,lease_expires_at=null,retry_at=now()+interval '60 seconds',last_error=$3 where id=$1 and tenant_id=$2 and claim_token=$4",
      [event.id,event.tenant_id,message.slice(0,1000),event.claim_token],
    );
  });
}

/** Recover callbacks that arrived before transaction correlation or whose provider query was inconclusive. */
export async function processRetryableProviderEvents(batchSize = 10): Promise<{ processed: number; retried: number; exceptions: number }> {
  const counts = { processed: 0, retried: 0, exceptions: 0 };
  const workerCapability = issuePaymentWorkerCapability();
  for (let i=0; i<Math.max(1,Math.min(50,batchSize)); i++) {
    const leaseToken = newLeaseToken();
    const event = await withPaymentWorkerTransaction(workerCapability, async (client) => {
      const selected = await client.query(
        `select e.id,e.tenant_id,e.provider,e.provider_event_id,e.payload,e.processing_attempts,
           t.id as transaction_id,t.amount_minor,t.currency,t.status
         from public.payment_provider_events e
         left join public.payment_transactions t on t.tenant_id=e.tenant_id and
           ((e.provider='daraja' and t.provider='daraja' and t.provider_checkout_request_id=e.provider_event_id) or
            (e.provider='pesapal' and t.provider='pesapal' and t.provider_order_tracking_id=e.provider_event_id) or\n            (e.provider='paystack' and t.provider='paystack' and t.provider_payment_reference=e.provider_event_id))
         where e.processing_status in ('retry','received')
           and e.retry_at <= now()
           and (e.lease_expires_at is null or e.lease_expires_at <= now())
         order by e.received_at
         limit 1 for update of e skip locked`,
      );
      const row = selected.rows[0];
      if (!row) return undefined;
      await client.query(
        "update public.payment_provider_events set processing_status='received',processing_attempts=processing_attempts+1,processing_started_at=now(),claim_token=$2,lease_expires_at=now()+interval '5 minutes',last_error=null where id=$1",
        [row.id,leaseToken],
      );
      return { ...row, claim_token: leaseToken } as RetryEvent;
    });
    if (!event) break;

    if (!event.transaction_id || event.amount_minor == null || event.currency == null) {
      await retryOwnedEvent(event,"Waiting for provider transaction correlation");
      counts.retried++;
      continue;
    }

    try {
      let outcome: "succeeded" | "failed" | undefined;
      let receipt: string | undefined;
      if (event.provider === "daraja") {
        const callback=event.payload?.Body?.stkCallback;
        const items=callback?.CallbackMetadata?.Item;
        const amount=Array.isArray(items) ? Number(items.find((item:any)=>item.Name==="Amount")?.Value) : NaN;
        receipt=Array.isArray(items) ? items.find((item:any)=>item.Name==="MpesaReceiptNumber")?.Value : undefined;
        const credentials=await getTenantProviderCredentials(event.tenant_id,"daraja",{kind:"worker",capability:workerCapability});
        const status=await queryDarajaStk(event.provider_event_id,credentials as Record<string,string>);
        if (String(status.ResultCode)==="0" && callback?.ResultCode===0 && Number.isFinite(amount) &&
            amount*100===Number(event.amount_minor) && typeof receipt==="string" && receipt.length>0) outcome="succeeded";
      } else if (event.provider === "pesapal") {
        const credentials=await getTenantProviderCredentials(event.tenant_id,"pesapal",{kind:"worker",capability:workerCapability});
        const status=await queryPesapalStatus(event.provider_event_id,credentials as Record<string,string>);
        const code=Number(status.status_code), amount=Number(status.amount);
        const currency=String(status.currency_code??status.currency??"").toUpperCase();
        const matches=Number.isFinite(amount) && Math.round(amount*100)===Number(event.amount_minor) &&
          currency===String(event.currency).trim().toUpperCase();
        if (matches && code===1) outcome="succeeded";
        else if (matches && code===2) outcome="failed";
        else if (code===0 && matches) {
          await retryOwnedEvent(event,"Provider payment is not terminal yet");
          counts.retried++;
          continue;
        }
      } else {
        const credentials=await getTenantProviderCredentials(event.tenant_id,"paystack",{kind:"worker",capability:workerCapability});
        const status=await verifyPaystackTransaction(event.provider_event_id,credentials as {secretKey:string;webhookSecret?:string});
        const code=String(status.status)==="success"?1:String(status.status)==="failed"?2:0;
        const amount=Number(status.amount);
        const currency=String(status.currency??"").toUpperCase();
        const matches=Number.isFinite(amount) && amount===Number(event.amount_minor) &&
          currency===String(event.currency).trim().toUpperCase();
        if (matches && code===1) outcome="succeeded";
        else if (matches && code===2) outcome="failed";
        else if (matches && code===0) {
          await retryOwnedEvent(event,"Paystack transaction is not terminal yet");
          counts.retried++;
          continue;
        }
      }

      await withPaymentWorkerTransaction(workerCapability,async(client)=>{
        const current=await client.query(
          "select status from public.payment_transactions where id=$1 and tenant_id=$2 and provider=$3 for update",
          [event.transaction_id,event.tenant_id,event.provider],
        );
        if (!current.rows[0]) throw new Error("Correlated transaction no longer exists");
        if (outcome && ["pending","unknown"].includes(current.rows[0].status)) {
          await client.query(
            "update public.payment_transactions set status=$1,provider_status=$2,provider_receipt=coalesce($3,provider_receipt),confirmed_at=case when $1='succeeded' then coalesce(confirmed_at,now()) else confirmed_at end,provider_verification_next_at=case when $1 in ('succeeded','failed') then 'infinity'::timestamptz else provider_verification_next_at end,provider_verification_lease_token=null,provider_verification_lease_expires_at=null,updated_at=now() where id=$4 and tenant_id=$5 and status in ('pending','unknown')",
            [outcome,event.provider+"_status_verified_recovery",receipt??null,event.transaction_id,event.tenant_id],
          );
          await client.query(
            "insert into public.payment_audit_events(tenant_id,action,entity_type,entity_id,correlation_id,metadata) values($1,$2,'transaction',$3,$4,$5::jsonb)",
            [event.tenant_id,event.provider+".callback.recovered",event.transaction_id,event.provider_event_id,JSON.stringify({status:outcome,receipt:receipt??null})],
          );
        } else if (!outcome || !["created","pending","unknown"].includes(current.rows[0].status)) {
          await client.query(
            "update public.payment_transactions set status='unknown',provider_status=$1,provider_verification_next_at='infinity',provider_verification_lease_token=null,provider_verification_lease_expires_at=null,updated_at=now() where id=$2 and tenant_id=$3 and status in ('created','pending')",
            [event.provider+"_recovery_requires_review",event.transaction_id,event.tenant_id],
          );
          await client.query(
            "insert into public.payment_reconciliation_exceptions(tenant_id,transaction_id,provider,provider_reference,exception_type,details) values($1,$2,$3,$4,'status_mismatch',$5::jsonb)",
            [event.tenant_id,event.transaction_id,event.provider,event.provider_event_id,JSON.stringify({reason:"Recovered provider status did not match the ledger or current terminal state."})],
          );
          counts.exceptions++;
        }
        const completed=await client.query(
          "update public.payment_provider_events set processing_status='processed',processed_at=now(),processing_started_at=null,claim_token=null,lease_expires_at=null,last_error=null where id=$1 and tenant_id=$2 and claim_token=$3 returning id",
          [event.id,event.tenant_id,event.claim_token],
        );
        if (!completed.rowCount) throw new Error("Provider event lease was lost before completion");
      });
      counts.processed++;
    } catch(error) {
      const message=error instanceof Error?error.message:"Unknown provider recovery error";
      await retryOwnedEvent(event,message);
      counts.retried++;
    }
  }
  return counts;
}


/** Poll Paystack transactions independently of webhooks so a lost callback cannot strand a payment. */
export async function processPaystackCheckoutRecovery(batchSize = 1): Promise<{ checked:number; settled:number; retried:number; exceptions:number }> {
  const counts={checked:0,settled:0,retried:0,exceptions:0};
  const workerCapability=issuePaymentWorkerCapability();
  for(let i=0;i<Math.max(1,Math.min(10,batchSize));i++){
    const leaseToken=newLeaseToken();
    const transaction=await withPaymentWorkerTransaction(workerCapability,async(client)=>{
      const selected=await client.query(
        `select id,tenant_id,provider_payment_reference,amount_minor,currency,status,provider_verification_attempts
         from public.payment_transactions
         where provider='paystack'
           and status in ('pending','unknown')
           and provider_status in ('checkout_created','checkout_result_unknown','pending','verification_retry')
           and provider_verification_next_at<=now()
           and (provider_verification_lease_expires_at is null or provider_verification_lease_expires_at<=now())
         order by provider_verification_next_at,created_at
         limit 1 for update skip locked`,
      );
      const row=selected.rows[0];
      if(!row)return undefined;
      await client.query(
        "update public.payment_transactions set provider_verification_attempts=provider_verification_attempts+1,provider_verification_lease_token=$2,provider_verification_lease_expires_at=now()+interval '45 seconds' where id=$1",
        [row.id,leaseToken],
      );
      return {...row,provider_verification_attempts:Number(row.provider_verification_attempts)+1,claim_token:leaseToken};
    });
    if(!transaction)break;
    counts.checked++;
    const attempts=Number(transaction.provider_verification_attempts);
    try{
      const credentials=await getTenantProviderCredentials(transaction.tenant_id,"paystack",{kind:"worker",capability:workerCapability});
      const verified=await verifyPaystackTransaction(String(transaction.provider_payment_reference),credentials as {secretKey:string;webhookSecret?:string});
      const status=String(verified.status??"");
      const amount=Number(verified.amount);
      const currency=String(verified.currency??"").toUpperCase();
      const matches=Number.isFinite(amount)&&amount===Number(transaction.amount_minor)&&currency===String(transaction.currency).toUpperCase();
      if(!matches){
        await withPaymentWorkerTransaction(workerCapability,async(client)=>{
          const updated=await client.query(
            "update public.payment_transactions set status=case when status='pending' then 'unknown' else status end,provider_status='verification_mismatch',provider_verification_last_error='Provider amount or currency did not match the transaction.',provider_verification_next_at='infinity',provider_verification_lease_token=null,provider_verification_lease_expires_at=null,updated_at=now() where id=$1 and tenant_id=$2 and provider_verification_lease_token=$3 and status in ('pending','unknown') returning id",
            [transaction.id,transaction.tenant_id,leaseToken],
          );
          if(updated.rowCount){
            await client.query(
              "insert into public.payment_reconciliation_exceptions(tenant_id,transaction_id,provider,provider_reference,exception_type,details) values($1,$2,'paystack',$3,'amount_mismatch',$4::jsonb)",
              [transaction.tenant_id,transaction.id,transaction.provider_payment_reference,JSON.stringify({reason:"Paystack verification amount or currency did not match the stored checkout."})],
            );
            counts.exceptions++;
          }
        });
        continue;
      }
      if(status==="pending"){
        const updated=await withPaymentWorkerTransaction(workerCapability,(client)=>client.query(
          "update public.payment_transactions set provider_status='pending',provider_verification_next_at=now()+interval '60 seconds',provider_verification_lease_token=null,provider_verification_lease_expires_at=null,provider_verification_last_error=null,updated_at=now() where id=$1 and tenant_id=$2 and provider_verification_lease_token=$3 and status in ('pending','unknown') returning id",
          [transaction.id,transaction.tenant_id,leaseToken],
        ));
        if(updated.rowCount)counts.retried++;
        continue;
      }
      const outcome=status==="success"?"succeeded":status==="failed"||status==="abandoned"?"failed":undefined;
      if(outcome){
        const result=await withPaymentWorkerTransaction(workerCapability,(client)=>client.query(
          "update public.payment_transactions set status=$1,provider_status=$2,provider_transaction_id=$3,confirmed_at=case when $1='succeeded' then coalesce(confirmed_at,now()) else confirmed_at end,provider_verification_next_at='infinity',provider_verification_lease_token=null,provider_verification_lease_expires_at=null,provider_verification_last_error=null,updated_at=now() where id=$4 and tenant_id=$5 and provider_verification_lease_token=$6 and status in ('pending','unknown') returning id",
          [outcome,status,verified.id==null?null:String(verified.id),transaction.id,transaction.tenant_id,leaseToken],
        ));
        if(result.rowCount)counts.settled++;
        continue;
      }
      throw new Error("Paystack returned a non-terminal transaction status");
    }catch(error){
      const message=error instanceof Error?error.message:"Paystack verification failed";
      await withPaymentWorkerTransaction(workerCapability,async(client)=>{
        if(attempts>=10){
          const updated=await client.query(
            "update public.payment_transactions set status=case when status='pending' then 'unknown' else status end,provider_status='verification_exhausted',provider_verification_next_at='infinity',provider_verification_lease_token=null,provider_verification_lease_expires_at=null,provider_verification_last_error=$4,updated_at=now() where id=$1 and tenant_id=$2 and provider_verification_lease_token=$3 and status in ('pending','unknown') returning id",
            [transaction.id,transaction.tenant_id,leaseToken,message.slice(0,800)],
          );
          if(updated.rowCount)await client.query(
            "insert into public.payment_reconciliation_exceptions(tenant_id,transaction_id,provider,provider_reference,exception_type,details) values($1,$2,'paystack',$3,'provider_mismatch',$4::jsonb)",
            [transaction.tenant_id,transaction.id,transaction.provider_payment_reference,JSON.stringify({reason:"Paystack checkout verification exhausted its retry budget.",lastError:message.slice(0,500)})],
          );
          if(updated.rowCount)counts.exceptions++;
        }else{
          const updated=await client.query(
            "update public.payment_transactions set provider_status='verification_retry',provider_verification_next_at=now()+interval '60 seconds',provider_verification_lease_token=null,provider_verification_lease_expires_at=null,provider_verification_last_error=$4,updated_at=now() where id=$1 and tenant_id=$2 and provider_verification_lease_token=$3 and status in ('pending','unknown') returning id",
            [transaction.id,transaction.tenant_id,leaseToken,message.slice(0,800)],
          );
          if(updated.rowCount)counts.retried++;
        }
      });
    }
  }
  return counts;
}
