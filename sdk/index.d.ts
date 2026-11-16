export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
export type AccessTokenProvider = string | (() => string | Promise<string>);
export interface MobiPayClientOptions {
  baseUrl?: string;
  accessToken?: AccessTokenProvider;
  fetch?: FetchLike;
}
export interface CheckoutResult { transactionId: string; status: string; redirectUrl?: string; reference?: string; message?: string; idempotentReplay?: boolean; }
export interface PublicCheckoutStatus { transaction: { id:string; provider:string; reference:string; amountMinor:number; currency:string; status:string; receipt?:string|null; confirmedAt?:string|null; createdAt?:string }; }
export interface PaymentRequest {
  amountMinor: number;
  merchantReference: string;
  description: string;
}
export interface DarajaStkRequest extends PaymentRequest {
  phone: string;
}
export interface HostedCheckoutRequest extends PaymentRequest {
  email?: string;
  phone?: string;
}
export interface PaystackCheckoutRequest extends PaymentRequest {
  email: string;
}
export interface MobiPayErrorOptions {
  status?: number;
  code?: string;
  details?: unknown;
}
export declare class MobiPayError extends Error {
  status: number;
  code: string;
  details?: unknown;
  constructor(message: string, options?: MobiPayErrorOptions);
}
export declare class MobiPayClient {
  constructor(options?: MobiPayClientOptions);
  listTenants(): Promise<unknown>;
  listTransactions(tenantId: string): Promise<unknown>;
  initiateDarajaStkPush(tenantId: string, payload: DarajaStkRequest, idempotencyKey: string): Promise<unknown>;
  createPesapalCheckout(tenantId: string, payload: HostedCheckoutRequest, idempotencyKey: string): Promise<CheckoutResult>;
  createPaystackCheckout(tenantId: string, payload: PaystackCheckoutRequest, idempotencyKey: string): Promise<CheckoutResult>;
  getPublicCheckoutStatus(tenantId: string, token: string): Promise<PublicCheckoutStatus>;
}
