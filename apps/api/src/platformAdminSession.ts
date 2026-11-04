import { createHmac, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

const COOKIE = "mobiwave_platform_admin";
const SESSION_SECONDS = 8 * 60 * 60;
type Session = { username: string; iat: number; exp: number };
const adminCapabilityBrand: unique symbol = Symbol("platform-admin-capability");
export interface PlatformAdminCapability {
  readonly username: string;
  readonly [adminCapabilityBrand]: true;
}
declare global {
  namespace Express {
    interface Request { platformAdminCapability?: PlatformAdminCapability; platformAdmin?: Session }
  }
}
function secret() {
  const value = process.env.PLATFORM_ADMIN_SESSION_SECRET ?? "";
  if (value.length < 32) throw new Error("PLATFORM_ADMIN_SESSION_SECRET must contain at least 32 characters");
  return value;
}
function sign(value: string) {
  return createHmac("sha256", secret()).update(value).digest("base64url");
}
function safeEqual(a: string, b: string) {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
function parseCookies(header = "") {
  return Object.fromEntries(header.split(";").map((part) => {
    const index = part.indexOf("=");
    return index < 0 ? ["", ""] : [part.slice(0, index).trim(), part.slice(index + 1).trim()];
  }).filter(([key]) => key));
}
export function createAdminSession(username: string) {
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({ username, iat: now, exp: now + SESSION_SECONDS } satisfies Session)).toString("base64url");
  return payload + "." + sign(payload);
}
export function verifyAdminSession(token?: string): Session | null {
  if (!token) return null;
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra) return null;
  try {
    if (!safeEqual(signature, sign(payload))) return null;
    const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Session;
    const now = Math.floor(Date.now() / 1000);
    if (!session.username || !Number.isInteger(session.iat) || session.iat < 0 ||
        session.iat > now + 60 || !Number.isInteger(session.exp) ||
        session.exp <= now || session.exp <= session.iat || session.exp - session.iat > SESSION_SECONDS) return null;
    return session;
  } catch { return null; }
}
export function setAdminSessionCookie(res: Response, token: string) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader("Set-Cookie", COOKIE + "=" + token + "; Path=/api/admin; Max-Age=" + SESSION_SECONDS + "; HttpOnly; SameSite=Strict" + secure);
}
export function clearAdminSessionCookie(res: Response) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader("Set-Cookie", COOKIE + "=; Path=/api/admin; Max-Age=0; HttpOnly; SameSite=Strict" + secure);
}
export function requirePlatformAdmin(req: Request, res: Response, next: NextFunction) {
  try {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    const session = verifyAdminSession(token);
    if (!session) return res.status(401).json({ error: "platform_admin_session_required" });
    req.platformAdmin = session;\n    req.platformAdminCapability = Object.freeze({ username: session.username, [adminCapabilityBrand]: true });
    return next();
  } catch {
    return res.status(503).json({ error: "platform_admin_session_not_configured" });
  }
}
export function verifyAdminCredentials(username: string, password: string) {
  const expectedUser = process.env.ADMIN_USERNAME ?? "";
  const expectedPassword = process.env.ADMIN_PASSWORD ?? "";
  if (!expectedUser || !expectedPassword) throw new Error("ADMIN_USERNAME and ADMIN_PASSWORD must be configured");
  return safeEqual(username.trim(), expectedUser) && safeEqual(password, expectedPassword);
}
export function adminUsername(req: Request) {
  return req.platformAdminCapability?.username ?? "unknown";
}
