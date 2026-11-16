import { timingSafeEqual } from "node:crypto";
import { processDueMerchantWebhookDeliveries } from "../apps/api/src/merchantWebhookWorker.js";
import { processRetryableProviderEvents } from "../apps/api/src/providerEventRecoveryWorker.js";

type WorkerRequest = { method?: string; headers: Record<string, string | string[] | undefined> };
type WorkerResponse = {
  setHeader(name: string, value: string): void;
  status(code: number): WorkerResponse;
  json(body: unknown): void;
};

function authorized(supplied: string | undefined, expected: string | undefined) {
  if (!supplied || !expected || expected.length < 32) return false;
  const a=Buffer.from(supplied), b=Buffer.from(`Bearer ${expected}`);
  return a.length===b.length && timingSafeEqual(a,b);
}

export default async function handler(req: WorkerRequest, res: WorkerResponse) {
  res.setHeader("Cache-Control","no-store");
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow","GET, POST");
    return res.status(405).json({error:"method_not_allowed"});
  }
  const authorization=req.headers.authorization;
  const value=Array.isArray(authorization)?authorization[0]:authorization;
  if (!authorized(value,process.env.WORKER_CRON_SECRET)) return res.status(401).json({error:"unauthorized"});
  try {
    const providerEvents=await processRetryableProviderEvents(10);
    const merchantWebhooks=await processDueMerchantWebhookDeliveries(20);
    return res.status(200).json({status:"completed",providerEvents,merchantWebhooks,processedAt:new Date().toISOString()});
  } catch {
    return res.status(503).json({error:"worker_iteration_failed"});
  }
}
