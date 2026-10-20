export type ReconciliationStatus = "matched" | "unmatched" | "amount_mismatch" | "ambiguous" | "duplicate";

export interface LedgerPayment {
  id: string;
  provider: string;
  providerReference?: string | null;
  merchantReference: string;
  amountMinor: number;
  currency: string;
}

export interface ProviderRecord {
  id: string;
  provider: string;
  providerReference?: string | null;
  merchantReference?: string | null;
  amountMinor: number;
  currency: string;
}

export interface ReconciliationResult {
  providerRecordId: string;
  status: ReconciliationStatus;
  paymentId?: string;
  reason: string;
}

function normalized(value: string | null | undefined): string {
  return (value ?? "").trim().toUpperCase();
}

/**
 * Deterministic, conservative matching: exact provider reference first, then
 * merchant reference + amount + currency. Ambiguous candidates are never forced.
 */
export function reconcileRecords(
  payments: LedgerPayment[],
  providerRecords: ProviderRecord[],
): ReconciliationResult[] {
  const results: ReconciliationResult[] = [];
  const seenProviderIds = new Set<string>();
  const claimedPayments = new Set<string>();

  for (const record of providerRecords) {
    const provider = normalized(record.provider);
    const providerRef = normalized(record.providerReference);
    const merchantRef = normalized(record.merchantReference);

    if (providerRef) {
      const duplicateKey = `${provider}:${providerRef}`;
      if (seenProviderIds.has(duplicateKey)) {
        results.push({ providerRecordId: record.id, status: "duplicate", reason: "Provider reference repeated in this reconciliation batch." });
        continue;
      }
      seenProviderIds.add(duplicateKey);
    }

    const sameProvider = payments.filter((payment) => normalized(payment.provider) === provider);
    let candidates = providerRef
      ? sameProvider.filter((payment) => normalized(payment.providerReference) === providerRef)
      : [];

    if (candidates.length === 0 && merchantRef) {
      candidates = sameProvider.filter((payment) => normalized(payment.merchantReference) === merchantRef);
    }

    if (candidates.length === 0) {
      results.push({ providerRecordId: record.id, status: "unmatched", reason: "No ledger payment matches the available provider or merchant reference." });
      continue;
    }

    if (candidates.length > 1) {
      results.push({ providerRecordId: record.id, status: "ambiguous", reason: "More than one ledger payment matches the reference; manual review is required." });
      continue;
    }

    const payment = candidates[0]!;
    if (claimedPayments.has(payment.id)) {
      results.push({ providerRecordId: record.id, status: "duplicate", paymentId: payment.id, reason: "A ledger payment was already matched to another provider record in this batch." });
      continue;
    }

    if (payment.amountMinor !== record.amountMinor || normalized(payment.currency) !== normalized(record.currency)) {
      results.push({ providerRecordId: record.id, status: "amount_mismatch", paymentId: payment.id, reason: "Reference matched but amount or currency differs; do not auto-confirm payment." });
      continue;
    }

    claimedPayments.add(payment.id);
    results.push({ providerRecordId: record.id, status: "matched", paymentId: payment.id, reason: "Unique reference, amount, and currency match." });
  }

  return results;
}
