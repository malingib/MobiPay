import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { NextFunction, Request, Response } from "express";

const merchantCapabilityBrand: unique symbol = Symbol("merchant-database-capability");
export interface MerchantDatabaseCapability {
  readonly [merchantCapabilityBrand]: true;
}
const merchantCapabilities = new WeakMap<object, string>();

/** Internal auth-boundary factory. Call only after successful JWT verification. */
export function issueMerchantDatabaseCapability(verifiedUserId: string): MerchantDatabaseCapability {
  if (typeof verifiedUserId !== "string" || !verifiedUserId.trim() || verifiedUserId.length > 256) {
    throw new Error("Verified merchant identity is required");
  }
  const capability = Object.freeze({ [merchantCapabilityBrand]: true as const });
  merchantCapabilities.set(capability, verifiedUserId);
  return capability;
}
export function merchantCapabilityUserId(value: unknown): string | undefined {
  return typeof value === "object" && value !== null ? merchantCapabilities.get(value) : undefined;
}
declare global {
  namespace Express {
    interface Request {
      authUser?: { id: string; claims: JWTPayload };
      merchantDbCapability?: MerchantDatabaseCapability;
    }
  }
}

let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;
let jwksUrl: string | undefined;

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const authorization = req.header("authorization");
  if (!authorization?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "authentication_required" });
  }
  const issuer = process.env.AUTH_ISSUER;
  const audience = process.env.AUTH_AUDIENCE;
  const jwksUri = process.env.AUTH_JWKS_URL;
  if (!issuer || !jwksUri) {
    return res.status(503).json({ error: "authentication_not_configured" });
  }
  try {
    if (!jwks || jwksUrl !== jwksUri) {
      jwks = createRemoteJWKSet(new URL(jwksUri));
      jwksUrl = jwksUri;
    }
    const { payload } = await jwtVerify(authorization.slice(7), jwks, { issuer, ...(audience ? { audience } : {}) });
    if (typeof payload.sub !== "string" || payload.sub.length < 1 || payload.sub.length > 256) {
      return res.status(401).json({ error: "invalid_identity" });
    }
    req.authUser = { id: payload.sub, claims: payload };
    req.merchantDbCapability = issueMerchantDatabaseCapability(payload.sub);
    return next();
  } catch {
    return res.status(401).json({ error: "invalid_token" });
  }
}
