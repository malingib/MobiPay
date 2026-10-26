export type PaymentStatus = "created" | "pending" | "succeeded" | "failed" | "cancelled" | "expired" | "unknown";

const allowedTransitions: Record<PaymentStatus, readonly PaymentStatus[]> = {
  created: ["pending", "failed", "cancelled", "unknown"],
  pending: ["succeeded", "failed", "cancelled", "expired", "unknown"],
  unknown: ["pending", "succeeded", "failed", "cancelled", "expired"],
  succeeded: [],
  failed: [],
  cancelled: [],
  expired: [],
};

/** Terminal outcomes are immutable. Repeated same-state updates are idempotent. */
export function isAllowedPaymentTransition(from: PaymentStatus, to: PaymentStatus): boolean {
  return from === to || allowedTransitions[from].includes(to);
}

export function assertAllowedPaymentTransition(from: PaymentStatus, to: PaymentStatus): void {
  if (!isAllowedPaymentTransition(from, to)) {
    throw new Error(`Invalid payment status transition: ${from} -> ${to}`);
  }
}
