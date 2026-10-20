# Security policy

## Reporting

Report suspected vulnerabilities privately to the MobiWave security/engineering contact before public disclosure. Do not include production credentials, customer data, or full payment payloads in issue reports.

## Sensitive data

Never commit API keys, client secrets, passkeys, bearer tokens, database service-role keys, customer exports, or production callback payloads. Rotate any credential that may have been exposed. Use separate sandbox and production secrets.

## Payment safety

- Browser redirects and client-supplied status values are not proof of payment.
- Verify provider status server-side before marking a transaction successful.
- Enforce idempotency and unique provider transaction references.
- Preserve audit history and use compensating events for corrections.
- Enforce tenant membership at both API and database boundaries.

## Release gates

A release that enables live payments requires review of authentication/authorization, callback verification, rate limits, secret handling, dependency vulnerabilities, audit logging, data retention, and automated tests for cross-tenant access and duplicate/replayed callbacks.