import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { __test, createAdminSecurity } from "../src/admin-security.mjs";

const activeKeyId = "test-v1";
const keyring = { [activeKeyId]: randomBytes(32).toString("base64") };
const recoveryPepper =
  "test-recovery-pepper-that-is-longer-than-thirty-two-characters";
const userId = "00000000-0000-4000-8000-000000000001";

test("TOTP follows the RFC 6238 SHA-1 test vector", () => {
  const secret = __test.encodeBase32(Buffer.from("12345678901234567890"));
  assert.equal(__test.codeForStep(secret, Math.floor(59 / 30)), "287082");
});

test("admin enrollment encrypts the secret and creates one-time recovery hashes", () => {
  const security = createAdminSecurity({
    activeKeyId,
    keyring,
    recoveryPepper,
    now: () => 1_700_000_000_000,
  });
  const enrollment = security.createEnrollment({
    userId,
    accountLabel: "admin@dufesh.cn",
  });

  assert.match(enrollment.secret, /^[A-Z2-7]{32}$/u);
  assert.match(enrollment.otpauthUri, /^otpauth:\/\/totp\//u);
  assert.equal(enrollment.recoveryCodes.length, 10);
  assert.match(enrollment.recoveryCodes[0], /^[A-Z2-7-]{30}$/u);
  assert.equal(new Set(enrollment.recoveryCodes).size, 10);
  assert.equal(enrollment.recoveryCodeHashes.length, 10);
  assert.notEqual(enrollment.encrypted.encryptedSecret, enrollment.secret);
  assert.doesNotMatch(
    JSON.stringify(enrollment.encrypted),
    new RegExp(enrollment.secret),
  );
});

test("TOTP verification accepts drift once and rejects replayed or malformed codes", () => {
  const timestamp = 1_700_000_000_000;
  const security = createAdminSecurity({
    activeKeyId,
    keyring,
    recoveryPepper,
    now: () => timestamp,
  });
  const enrollment = security.createEnrollment({ userId, accountLabel: "admin" });
  const currentStep = Math.floor(timestamp / 1_000 / 30);
  const code = __test.codeForStep(enrollment.secret, currentStep);

  const context = { factorId: enrollment.factorId, userId };
  assert.equal(
    security.verifyTotp(enrollment.encrypted, context, code),
    currentStep,
  );
  assert.equal(
    security.verifyTotp(enrollment.encrypted, context, code, currentStep),
    null,
  );
  assert.equal(
    security.verifyTotp(enrollment.encrypted, context, "12345"),
    null,
  );
  assert.throws(
    () =>
      security.verifyTotp(
        enrollment.encrypted,
        { factorId: enrollment.factorId, userId: `${userId}-other` },
        code,
      ),
    /authenticate data|unable to authenticate/u,
  );
});

test("recovery code hashing is normalized and bound to the server pepper", () => {
  const first = createAdminSecurity({
    activeKeyId,
    keyring,
    recoveryPepper,
  });
  const second = createAdminSecurity({
    activeKeyId,
    keyring,
    recoveryPepper: `${recoveryPepper}-different`,
  });

  assert.equal(
    first.hashRecoveryCode("ABCD-EFGH-IJKL"),
    first.hashRecoveryCode("abcd-efgh-ijkl"),
  );
  assert.notEqual(
    first.hashRecoveryCode("ABCD-EFGH-IJKL"),
    second.hashRecoveryCode("ABCD-EFGH-IJKL"),
  );
});

test("admin security rejects missing or malformed encryption keys", () => {
  assert.throws(
    () =>
      createAdminSecurity({
        activeKeyId: "bad",
        keyring: { bad: "short" },
        recoveryPepper,
      }),
    /invalid key/u,
  );
});
