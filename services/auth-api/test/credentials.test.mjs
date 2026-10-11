import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeEmail,
  normalizeLoginIdentifier,
  normalizeUsername,
  validateAccountNameChange,
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
    password: "Moonlight!2026-Long",
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
    username: " ",
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

test("registration and profile accept 1–24 Unicode username code points with unchanged identity normalization", () => {
  for (const username of ["a", "海", "小影", "𠀀", "𠀀".repeat(24)]) {
    const registration = validateRegistration({ username, email: "shortnames@example.com", password: "a calm river crosses the harbor" });
    assert.equal(registration.ok, true, username);
    const profile = validateProfileUpdate({ username });
    assert.equal(profile.ok, true, username);
    assert.equal(profile.value.normalizedUsername, registration.value.normalizedUsername);
  }
  assert.equal(validateProfileUpdate({ username: "  Ａ " }).value.normalizedUsername, "a");
  for (const username of ["", " ", "𠀀".repeat(25), "a b", "<script>", "a@b"]) {
    assert.equal(validateRegistration({ username, email: "shortnames@example.com", password: "a calm river crosses the harbor" }).ok, false);
    assert.equal(validateProfileUpdate({ username }).ok, false);
  }
});

test("registration and reset share 8–128 Unicode password bounds while legacy login stays compatible", () => {
  for (const [password, expected] of [["river77", false], ["river777", true], ["😀".repeat(128), true], ["😀".repeat(129), false]]) {
    assert.equal(validateNewPassword(password, ["a", "learner@example.com"]), expected);
    assert.equal(validateRegistration({ username: "a", email: "learner@example.com", password }).ok, expected);
  }
  assert.deepEqual(validateLogin({ identifier: "a", password: "old" }), { identifier: "a", password: "old" });
  for (const password of ["12345678", "qwertyui", "password", "00000000", "abcdefgh"]) {
    assert.equal(validateNewPassword(password), false);
    assert.equal(validateRegistration({ username: "a", email: "learner@example.com", password }).ok, false);
  }
});

test("short username hints do not reject unrelated passwords and longer identities remain protected", () => {
  for (const username of ["a", "ab", "𠀀𠀁"]) {
    const password = `${username} river777`;
    assert.equal(validateNewPassword(password, [username]), true);
    assert.equal(validateRegistration({ username, email: "learner@example.com", password }).ok, true);
  }
  for (const username of ["abc", "𠀀𠀁𠀂"]) {
    const password = `${username} river777`;
    assert.equal(validateNewPassword(password, [username]), false);
    assert.equal(validateRegistration({ username, email: "learner@example.com", password }).ok, false);
  }
  assert.equal(validateNewPassword("learner-river777", ["learner@example.com"]), false);
});

test("optional student number retains its format and unverified contract", () => {
  for (const schoolAccount of ["", "20261234", "AB-2026_"]) {
    const registration = validateRegistration({ username: "海", email: "number@example.com", password: "river777", schoolAccount });
    assert.equal(registration.ok, true);
    assert.equal(registration.value.schoolAccount, schoolAccount || null);
    assert.equal(validateProfileUpdate({ schoolAccount }).value.schoolAccount, schoolAccount || null);
  }
  const registration = validateRegistration({ username: "海", email: "number@example.com", password: "river777", schoolAccount: "**" });
  const profile = validateProfileUpdate({ schoolAccount: "**" });
  assert.match(registration.fields.schoolAccount, /^学号需为 4—32/u);
  assert.equal(profile.fields.schoolAccount, registration.fields.schoolAccount);
});

test("registration offers only the canonical momo display name while keeping a distinct login username", () => {
  const input = { username: "海", email: "number@example.com", password: "river777" };
  assert.equal(validateRegistration(input).value.displayName, "海");
  assert.equal(validateRegistration(input).value.nameMode, "name");
  for (const displayName of ["momo", "MOMO", " ｍｏｍｏ "]) {
    const result = validateRegistration({ ...input, displayName });
    assert.equal(result.ok, true);
    assert.equal(result.value.username, "海");
    assert.equal(result.value.displayName, "momo");
    assert.equal(result.value.nameMode, "momo");
  }
  assert.equal(validateRegistration({ ...input, username: "MOMO" }).value.displayName, "MOMO");
  assert.equal(validateRegistration({ ...input, username: "MOMO" }).value.nameMode, "name");
  for (const displayName of ["海风", "", "momo\nother", "mo\u200bmo", {}, null]) {
    const result = validateRegistration({ ...input, displayName });
    assert.equal(result.ok, false);
    assert.deepEqual(Object.keys(result.fields), ["displayName"]);
  }
});

test("name change requests reuse visible-name validation and accept only actual name fields", () => {
  assert.deepEqual(validateAccountNameChange({ username: " Ａ ", displayName: " 海风 " }), {
    ok: true, value: { username: "A", normalizedUsername: "a", displayName: "海风" },
  });
  assert.match(validateAccountNameChange({ displayName: " ＭＯＭＯ " }).fields.displayName, /展示切换/u);
  assert.equal(validateAccountNameChange({ displayName: "😀".repeat(40) }).ok, true);
  for (const input of [null, [], {}, { schoolAccount: "20260001" }, { role: "admin" },
    { username: "海", userId: "other" }, { displayName: "😀".repeat(41) }, { displayName: "\u200b" },
    { username: "" }, { displayName: "" }]) {
    assert.equal(validateAccountNameChange(input).ok, false);
  }
});

test("login and reset password validation use bounded scalar input", () => {
  assert.deepEqual(
    validateLogin({ identifier: " Student@Example.com ", password: "secret" }),
    { identifier: "student@example.com", password: "secret" },
  );
  assert.equal(validateLogin({ identifier: {}, password: [] }), null);
  assert.equal(validateNewPassword("Moonlight!2026-Long", ["alice"]), true);
  assert.equal(validateNewPassword("alice!2026x", ["alice"]), false);
});

test("password service creates Argon2id hashes and verifies without exposing plaintext", async () => {
  const passwords = createPasswordService();
  const passwordHash = await passwords.hash("Moonlight!2026-Long");
  assert.match(passwordHash, /^\$argon2id\$/);
  assert.equal(passwordHash.includes("Moonlight!2026-Long"), false);
  assert.equal(await passwords.verify(passwordHash, "Moonlight!2026-Long"), true);
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
