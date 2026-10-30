import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { clearAdminSessionCookie, createAdminSession, requirePlatformAdmin, setAdminSessionCookie, verifyAdminCredentials } from "./platformAdminSession.js";

const router = Router();
const loginLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 10, standardHeaders: "draft-8", legacyHeaders: false, message: { error: "admin_login_rate_limited" } });
const loginSchema = z.object({ username: z.string().trim().min(1).max(128), password: z.string().min(1).max(1024) });

router.post("/session", loginLimiter, (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_credentials" });
  try {
    if (!verifyAdminCredentials(parsed.data.username, parsed.data.password)) {
      return res.status(401).json({ error: "invalid_credentials" });
    }
    const username = process.env.PLATFORM_ADMIN_NAME?.trim() || parsed.data.username.trim();
    const token = createAdminSession(username);
    setAdminSessionCookie(res, token);
    return res.json({ authenticated: true, administrator: { username }, expiresIn: 28800 });
  } catch {
    return res.status(503).json({ error: "platform_admin_not_configured" });
  }
});
router.get("/session", requirePlatformAdmin, (req, res) => {
  const session = (req as typeof req & { platformAdmin?: { username: string; exp: number } }).platformAdmin;
  return res.json({ authenticated: true, administrator: { username: session?.username }, expiresAt: session?.exp });
});
router.delete("/session", (_req, res) => {
  clearAdminSessionCookie(res);
  return res.status(204).end();
});
export default router;
