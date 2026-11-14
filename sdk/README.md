# @mobiwave/mobipay-sdk

A small Fetch-based JavaScript client for MobiPay's authenticated merchant API.

## Usage

```js
import { MobiPayClient } from "@mobiwave/mobipay-sdk";

const client = new MobiPayClient({
  baseUrl: "https://pay.mobiwave.co.ke",
  // Supply a short-lived, verified Neon Auth access token.
  accessToken: async () => getCurrentNeonAuthAccessToken(),
});

const checkout = await client.createPaystackCheckout(
  tenantId,
  {
    amountMinor: 12500,
    merchantReference: "INV-1042",
    description: "Invoice 1042",
    email: "customer@example.com",
  },
  crypto.randomUUID(),
);

console.log(checkout.redirectUrl);
```

## Supported operations

- List merchant workspaces and transactions.
- Initiate Daraja STK Push.
- Create Pesapal hosted checkout.
- Create Paystack hosted checkout.
- Read the public status of a checkout using its unguessable return token.

## Security notes

- This client does not store credentials or tokens.
- Use a short-lived Neon Auth access token; never embed a server secret in a public browser bundle.
- Supply a fresh idempotency key for each new payment attempt and reuse the same key only when retrying the identical request.
- Customer status lookups use an opaque bearer token and do not require a merchant access token.
- Live payment processing remains disabled until the production release gates are cleared.

The SDK intentionally has no provider secret-key parameters. Provider credentials remain encrypted and merchant-scoped in MobiPay.
