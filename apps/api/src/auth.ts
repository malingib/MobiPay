import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { NextFunction, Request, Response } from "express";

declare global {
  namespace Express {
    interface Request { authUser?: { id: string; claims: JWTPayload } }
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
    return next();
  } catch {
    return res.status(401).json({ error: "invalid_token" });
  }
}
