import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeEmail,
  normalizeLoginIdentifier,
  normalizeUsername,
  validateLogin,
  validateNewPassword,
  validateProfileUpdate,
  validateRegistration,
} from "../src/credentials.mjs";
import { createPasswordService } from "../src/passwords.mjs";

test("credential identifiers are normalized without changing the display username", () => {
  assert.equal(normalizeUsername("  Ａlice_01  "), "alice_01");
  assert.equal(normalizeEmail(" Student@DUFE.EDU.CN "), "student@dufe.edu.cn");
  assert.equal(normalizeLoginIdentifier("  张三-2025 "), "张三-2025");
});

test("registration validates fields and rejects weak or identity-derived passwords", () => {
  const valid = validateRegistration({
    username: "海边自习室",
    email: "student@example.com",
    password: "Moonlight!2026",
    schoolAccount: "2026123456",
  });
  assert.equal(valid.ok, true);
  assert.equal(valid.value.normalizedUsername, "海边自习室");

  const weak = validateRegistration({
    username: "alice",
    email: "alice@example.com",
    password: "alice123456",
  });
  assert.equal(weak.ok, false);
  assert.ok(weak.fields.password);

  const malformed = validateRegistration({
    username: "a",
    email: "not-an-email",
    password: "short",
    schoolAccount: "**",
  });
  assert.deepEqual(Object.keys(malformed.fields).sort(), [
    "email",
    "password",
    "schoolAccount",
    "username",
  ]);
});

test("login and reset password validation use bounded scalar input", () => {
  assert.deepEqual(
    validateLogin({ identifier: " Student@Example.com ", password: "secret" }),
    { identifier: "student@example.com", password: "secret" },
  );
  assert.equal(validateLogin({ identifier: {}, password: [] }), null);
  assert.equal(validateNewPassword("Moonlight!2026", ["alice"]), true);
  assert.equal(validateNewPassword("alice!2026x", ["alice"]), false);
});

test("password service creates Argon2id hashes and verifies without exposing plaintext", async () => {
  const passwords = createPasswordService();
  const passwordHash = await passwords.hash("Moonlight!2026");
  assert.match(passwordHash, /^\$argon2id\$/);
  assert.equal(passwordHash.includes("Moonlight!2026"), false);
  assert.equal(await passwords.verify(passwordHash, "Moonlight!2026"), true);
  assert.equal(await passwords.verify(passwordHash, "wrong-password"), false);
});

test("profile updates allow only editable fields and normalize identity values", () => {
  const valid = validateProfileUpdate({
    username: "  新名字-26 ",
    displayName: " 海风 ",
    schoolAccount: " 2026123456 ",
  });
  assert.equal(valid.ok, true);
  assert.deepEqual(valid.value, {
    username: "新名字-26",
    normalizedUsername: "新名字-26",
    displayName: "海风",
    schoolAccount: "2026123456",
  });

  const massAssignment = validateProfileUpdate({
    displayName: "普通用户",
    status: "admin",
  });
  assert.equal(massAssignment.ok, false);
  assert.ok(massAssignment.fields.profile);

  const empty = validateProfileUpdate({});
  assert.equal(empty.ok, false);
});
