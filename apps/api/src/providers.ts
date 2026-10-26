import { createHash } from "node:crypto";

function required(name: string, credentials?: Record<string, string>) {
  const credentialFields: Record<string, string> = {
    DARAJA_CONSUMER_KEY: "consumerKey", DARAJA_CONSUMER_SECRET: "consumerSecret", DARAJA_SHORTCODE: "shortCode", DARAJA_PASSKEY: "passkey",
    PESAPAL_CONSUMER_KEY: "consumerKey", PESAPAL_CONSUMER_SECRET: "consumerSecret", PESAPAL_IPN_ID: "ipnId",
  };
  const value = credentials?.[credentialFields[name] ?? ""] ?? process.env[name];
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}
function timestamp() {
  // Daraja timestamps are interpreted in East Africa Time, regardless of host timezone.
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Nairobi", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date());
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}${part("month")}${part("day")}${part("hour")}${part("minute")}${part("second")}`;
}
function baseUrl(name: string, fallback: string) {
  return (process.env[name] ?? fallback).replace(/\/$/, "");
}
async function responseJson(response: Response) {
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new Error(`Provider request failed with HTTP ${response.status}`);
  return body;
}

export async function darajaAccessToken(credentials?: Record<string, string>) {
  const authHeader = Buffer.from(`${required("DARAJA_CONSUMER_KEY", credentials)}:${required("DARAJA_CONSUMER_SECRET", credentials)}`).toString("base64");
  const response = await fetch(`${baseUrl("DARAJA_BASE_URL","https://sandbox.safaricom.co.ke")}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { authorization: `Basic ${authHeader}` },
    signal: AbortSignal.timeout(10_000),
  });
  const body = await responseJson(response);
  if (typeof body.access_token !== "string") throw new Error("Daraja did not return an access token");
  return body.access_token;
}

export async function initiateDarajaStk(input: { phone: string; amount: number; accountReference: string; description: string; callbackUrl: string }, credentials?: Record<string, string>) {
  if ((process.env.DARAJA_ENV ?? "sandbox") !== "sandbox") throw new Error("Live Daraja initiation is disabled pending production readiness approval");
  const token = await darajaAccessToken(credentials);
  const shortCode = required("DARAJA_SHORTCODE", credentials), passkey = required("DARAJA_PASSKEY", credentials);
  const time = timestamp();
  const password = Buffer.from(`${shortCode}${passkey}${time}`).toString("base64");
  const response = await fetch(`${baseUrl("DARAJA_BASE_URL","https://sandbox.safaricom.co.ke")}/mpesa/stkpush/v1/processrequest`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      BusinessShortCode: shortCode, Password: password, Timestamp: time, TransactionType: "CustomerPayBillOnline",
      Amount: input.amount, PartyA: input.phone, PartyB: shortCode, PhoneNumber: input.phone,
      CallBackURL: input.callbackUrl, AccountReference: input.accountReference.slice(0,12),
      TransactionDesc: input.description.slice(0,13),
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await responseJson(response);
  if (typeof body.CheckoutRequestID !== "string" || typeof body.ResponseCode !== "string" || body.ResponseCode !== "0") {
    throw new Error("Daraja did not accept the STK push request");
  }
  return { checkoutRequestId: body.CheckoutRequestID, merchantRequestId: String(body.MerchantRequestID ?? ""), responseDescription: String(body.ResponseDescription ?? "") };
}

export async function queryDarajaStk(checkoutRequestId: string, credentials?: Record<string, string>) {
  const token = await darajaAccessToken(credentials);
  const shortCode = required("DARAJA_SHORTCODE", credentials), passkey = required("DARAJA_PASSKEY", credentials);
  const time = timestamp();
  const password = Buffer.from(`${shortCode}${passkey}${time}`).toString("base64");
  const response = await fetch(`${baseUrl("DARAJA_BASE_URL","https://sandbox.safaricom.co.ke")}/mpesa/stkpushquery/v1/query`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ BusinessShortCode: shortCode, Password: password, Timestamp: time, CheckoutRequestID: checkoutRequestId }),
    signal: AbortSignal.timeout(15_000),
  });
  return responseJson(response);
}

export async function pesapalAccessToken(credentials?: Record<string, string>) {
  if ((process.env.PESAPAL_ENV ?? "sandbox") !== "sandbox") throw new Error("Live Pesapal operations are disabled pending production readiness approval");
  const response = await fetch(`${baseUrl("PESAPAL_BASE_URL","https://cybqa.pesapal.com/pesapalv3")}/api/Auth/RequestToken`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ consumer_key: required("PESAPAL_CONSUMER_KEY", credentials), consumer_secret: required("PESAPAL_CONSUMER_SECRET", credentials) }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = await responseJson(response);
  if (typeof body.token !== "string") throw new Error("Pesapal did not return an access token");
  return body.token;
}

export async function submitPesapalOrder(input: { reference: string; amount: number; description: string; callbackUrl: string; email?: string; phone?: string }, credentials?: Record<string, string>) {
  const token = await pesapalAccessToken(credentials);
  const response = await fetch(`${baseUrl("PESAPAL_BASE_URL","https://cybqa.pesapal.com/pesapalv3")}/api/Transactions/SubmitOrderRequest`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      id: input.reference, currency: "KES", amount: input.amount, description: input.description,
      callback_url: input.callbackUrl, notification_id: required("PESAPAL_IPN_ID", credentials),
      billing_address: { email_address: input.email ?? "payments@example.invalid", phone_number: input.phone ?? "", country_code: "KE" },
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await responseJson(response);
  if (typeof body.order_tracking_id !== "string" || typeof body.redirect_url !== "string") throw new Error("Pesapal did not return order tracking details");
  return { orderTrackingId: body.order_tracking_id, redirectUrl: body.redirect_url, merchantReference: String(body.merchant_reference ?? input.reference) };
}

export async function queryPesapalStatus(orderTrackingId: string, credentials?: Record<string, string>) {
  const token = await pesapalAccessToken(credentials);
  const response = await fetch(`${baseUrl("PESAPAL_BASE_URL","https://cybqa.pesapal.com/pesapalv3")}/api/Transactions/GetTransactionStatus?orderTrackingId=${encodeURIComponent(orderTrackingId)}`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  return responseJson(response);
}

export function sha256Payload(payload: unknown) {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}
