export type IdempotentPaymentRequest = {
  provider: string;
  merchantReference: string;
  amountMinor: number;
  currency: string;
  payerReference?: string | null;
  payerEmail?: string | null;
  description?: string | null;
};

export type IdempotentPaymentRecord = {
  provider: string;
  merchant_reference: string;
  amount_minor: number | string;
  currency: string;
  payer_reference?: string | null;
  payer_email?: string | null;
  description?: string | null;
};

/** Compare every client-controlled field before replaying an idempotent response. */
export function matchesIdempotentPaymentRequest(
  existing: IdempotentPaymentRecord,
  requested: IdempotentPaymentRequest,
): boolean {
  return existing.provider === requested.provider &&
    existing.merchant_reference === requested.merchantReference &&
    Number(existing.amount_minor) === requested.amountMinor &&
    existing.currency.trim() === requested.currency &&
    (existing.payer_reference ?? null) === (requested.payerReference ?? null) &&
    (existing.payer_email ?? null) === (requested.payerEmail ?? null) &&
    (existing.description ?? null) === (requested.description ?? null);
}
