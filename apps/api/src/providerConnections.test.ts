import test from "node:test";
import assert from "node:assert/strict";
import { decryptProviderCredentials, encryptProviderCredentials } from "./providerConnections.js";

test("merchant provider credentials are encrypted and round-trip", () => {
  process.env.PROVIDER_CREDENTIALS_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  const secret = {
    consumerKey: "sandbox-consumer-key-123456",
    consumerSecret: "private-consumer-secret-abcdef",
    shortCode: "123456",
    passkey: "very-private-passkey-123456789",
  };
  const ciphertext = encryptProviderCredentials(secret);
  assert.match(ciphertext, /^v1:/);
  assert.equal(ciphertext.includes(secret.consumerKey), false);
  assert.equal(ciphertext.includes(secret.consumerSecret), false);
  assert.deepEqual(decryptProviderCredentials(ciphertext), secret);
});

test("merchant credential encryption rejects a modified ciphertext", () => {
  process.env.PROVIDER_CREDENTIALS_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  const ciphertext = encryptProviderCredentials({
    consumerKey: "sandbox-consumer-key-123456",
    consumerSecret: "private-consumer-secret-abcdef",
    shortCode: "123456",
    passkey: "very-private-passkey-123456789",
  });
  const parts = ciphertext.split(":");
  const encrypted = parts[3] ?? "";
  parts[3] = (encrypted.startsWith("A") ? "B" : "A") + encrypted.slice(1);
  assert.throws(() => decryptProviderCredentials(parts.join(":")));
});

test("merchant credential encryption requires a 32-byte key", () => {
  process.env.PROVIDER_CREDENTIALS_ENCRYPTION_KEY = Buffer.alloc(12, 3).toString("base64");
  assert.throws(() => encryptProviderCredentials({
    consumerKey: "sandbox-consumer-key-123456",
    consumerSecret: "private-consumer-secret-abcdef",
    shortCode: "123456",
    passkey: "very-private-passkey-123456789",
  }), /32-byte key/);
});
