import assert from "node:assert/strict";
import { test } from "node:test";
import { createAdminSession, verifyAdminSession, verifyAdminCredentials } from "./platformAdminSession.js";

test("platform admin session is signed and identifies the administrator", () => {
  const prior = process.env.PLATFORM_ADMIN_SESSION_SECRET;
  process.env.PLATFORM_ADMIN_SESSION_SECRET = "test-session-secret-that-is-long-enough-123456";
  try {
    const token = createAdminSession("ops");
    assert.equal(verifyAdminSession(token)?.username, "ops");
    assert.equal(verifyAdminSession(token + "tampered"), null);
    assert.equal(verifyAdminSession(token.split(".")[0] + ".invalid"), null);
  } finally {
    if (prior === undefined) delete process.env.PLATFORM_ADMIN_SESSION_SECRET;
    else process.env.PLATFORM_ADMIN_SESSION_SECRET = prior;
  }
});

test("platform admin credentials are independent of merchant identity claims", () => {
  const priorUser = process.env.ADMIN_USERNAME, priorPassword = process.env.ADMIN_PASSWORD;
  process.env.ADMIN_USERNAME = "platform-ops";
  process.env.ADMIN_PASSWORD = "strong-test-password";
  try {
    assert.equal(verifyAdminCredentials("platform-ops", "strong-test-password"), true);
    assert.equal(verifyAdminCredentials("merchant@example.com", "strong-test-password"), false);
    assert.equal(verifyAdminCredentials("platform-ops", "wrong-password"), false);
  } finally {
    if (priorUser === undefined) delete process.env.ADMIN_USERNAME; else process.env.ADMIN_USERNAME = priorUser;
    if (priorPassword === undefined) delete process.env.ADMIN_PASSWORD; else process.env.ADMIN_PASSWORD = priorPassword;
  }
});
