const DEFAULT_BASE_URL = "https://pay.mobiwave.co.ke";

export class MobiPayError extends Error {
  constructor(message, { status = 0, code = "request_failed", details } = {}) {
    super(message);
    this.name = "MobiPayError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export class MobiPayClient {
  constructor({ baseUrl = DEFAULT_BASE_URL, accessToken, fetch: fetchImpl = globalThis.fetch } = {}) {
    if (typeof fetchImpl !== "function") throw new TypeError("A Fetch-compatible implementation is required");
    this.baseUrl = String(baseUrl).replace(/\/+$/, "");
    this.accessToken = accessToken;
    this.fetch = fetchImpl;
  }

  async request(path, { method = "GET", body, idempotencyKey, authenticated = true } = {}) {
    const headers = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
    if (authenticated) {
      const token = typeof this.accessToken === "function" ? await this.accessToken() : this.accessToken;
      if (!token) throw new MobiPayError("A verified Neon Auth access token is required", { code: "access_token_required" });
      headers.authorization = "Bearer " + token;
    }
    let response;
    try {
      response = await this.fetch(this.baseUrl + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: "no-store",
      });
    } catch (error) {
      throw new MobiPayError(error instanceof Error ? error.message : "Network request failed", { code: "network_error" });
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new MobiPayError(payload.message || payload.error || "MobiPay request failed", {
        status: response.status,
        code: payload.error || "request_failed",
        details: payload.details,
      });
    }
    return payload;
  }

  listTenants() {
    return this.request("/api/v1/tenants");
  }

  listTransactions(tenantId) {
    return this.request("/api/v1/tenants/" + encodeURIComponent(tenantId) + "/transactions");
  }

  initiateDarajaStkPush(tenantId, payload, idempotencyKey) {
    return this.request("/api/v1/tenants/" + encodeURIComponent(tenantId) + "/daraja/stk-push", {
      method: "POST", body: payload, idempotencyKey,
    });
  }

  createPesapalCheckout(tenantId, payload, idempotencyKey) {
    return this.request("/api/v1/tenants/" + encodeURIComponent(tenantId) + "/pesapal/checkout", {
      method: "POST", body: payload, idempotencyKey,
    });
  }

  createPaystackCheckout(tenantId, payload, idempotencyKey) {
    return this.request("/api/v1/tenants/" + encodeURIComponent(tenantId) + "/paystack/checkout", {
      method: "POST", body: payload, idempotencyKey,
    });
  }

  getPublicCheckoutStatus(tenantId, token) {
    return this.request(
      "/api/v1/public/checkout/" + encodeURIComponent(tenantId) + "/" + encodeURIComponent(token),
      { authenticated: false },
    );
  }
}
