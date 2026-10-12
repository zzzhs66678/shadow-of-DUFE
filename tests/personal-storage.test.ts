import assert from "node:assert/strict";
import test from "node:test";
import {
  anonymousPersonalScope,
  isPersonalCloudBootstrapPending,
  migrateLegacyPersonalStorage,
  personalStorageKey,
  readPersonalStorage,
  removePersonalStorage,
  setPersonalCloudBootstrapPending,
  userPersonalScope,
  writePersonalStorage,
  type PersonalStorage,
} from "../app/personal-storage.ts";

function memoryStorage(): PersonalStorage & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, value);
    },
    removeItem(key) {
      values.delete(key);
    },
  };
}

test("legacy personal data migrates only into the anonymous scope", () => {
  const storage = memoryStorage();
  storage.setItem(
    "dufesh:student-profile:v2",
    JSON.stringify({ plans: ["legacy-plan"] }),
  );

  assert.equal(migrateLegacyPersonalStorage(storage), true);
  assert.deepEqual(readPersonalStorage(storage, anonymousPersonalScope), {
    plans: ["legacy-plan"],
  });
  assert.equal(
    readPersonalStorage(storage, userPersonalScope("user-a")),
    null,
  );
  assert.equal(storage.getItem("dufesh:student-profile:v2"), null);
  assert.deepEqual(
    JSON.parse(storage.getItem("dufesh:student-profile:v2:migration-backup")!),
    { plans: ["legacy-plan"] },
  );
});

test("legacy migration preserves both records when anonymous storage already exists", () => {
  const storage = memoryStorage();
  const legacy = JSON.stringify({ plans: ["legacy-plan"] });
  storage.setItem("dufesh:student-profile:v2", legacy);
  writePersonalStorage(storage, anonymousPersonalScope, { plans: ["guest-plan"] });
  storage.setItem("dufesh:personal-sync:v1", JSON.stringify({
    schemaVersion: 1, userId: "user-a", revision: 3, baseState: { plans: ["cloud-plan"] },
  }));

  migrateLegacyPersonalStorage(storage);

  assert.deepEqual(readPersonalStorage(storage, anonymousPersonalScope), { plans: ["guest-plan"] });
  assert.equal(storage.getItem("dufesh:student-profile:v2:migration-backup"), legacy);
  assert.equal(readPersonalStorage(storage, userPersonalScope("user-a")), null);
});

test("legacy source remains recoverable when a backup exceeds browser storage capacity", () => {
  const storage = memoryStorage();
  const legacy = JSON.stringify({ plans: ["legacy-plan"] });
  storage.setItem("dufesh:student-profile:v2", legacy);
  const setItem = storage.setItem;
  storage.setItem = (key, value) => {
    if (key.endsWith(":migration-backup")) throw new Error("quota exceeded");
    setItem(key, value);
  };

  assert.doesNotThrow(() => migrateLegacyPersonalStorage(storage));
  assert.equal(storage.getItem("dufesh:student-profile:v2"), legacy);
  assert.deepEqual(readPersonalStorage(storage, anonymousPersonalScope), { plans: ["legacy-plan"] });
});

test("anonymous and account scopes never read each other's records", () => {
  const storage = memoryStorage();
  const userA = userPersonalScope("user-a");
  const userB = userPersonalScope("user-b");

  writePersonalStorage(storage, anonymousPersonalScope, { owner: "guest" });
  writePersonalStorage(storage, userA, { owner: "a" });
  writePersonalStorage(storage, userB, { owner: "b" });

  assert.deepEqual(readPersonalStorage(storage, anonymousPersonalScope), {
    owner: "guest",
  });
  assert.deepEqual(readPersonalStorage(storage, userA), { owner: "a" });
  assert.deepEqual(readPersonalStorage(storage, userB), { owner: "b" });
  assert.notEqual(personalStorageKey(userA), personalStorageKey(userB));
});

test("logout cleanup removes only the current account cache", () => {
  const storage = memoryStorage();
  const userA = userPersonalScope("user-a");
  const userB = userPersonalScope("user-b");
  writePersonalStorage(storage, anonymousPersonalScope, { owner: "guest" });
  writePersonalStorage(storage, userA, { owner: "a" });
  writePersonalStorage(storage, userB, { owner: "b" });

  removePersonalStorage(storage, userA);

  assert.equal(readPersonalStorage(storage, userA), null);
  assert.deepEqual(readPersonalStorage(storage, userB), { owner: "b" });
  assert.deepEqual(readPersonalStorage(storage, anonymousPersonalScope), {
    owner: "guest",
  });
});

test("pending cloud bootstrap markers remain isolated and disappear with their account cache", () => {
  const storage = memoryStorage();
  const userA = userPersonalScope("user-a"), userB = userPersonalScope("user-b");
  for (const scope of [userA, userB]) {
    setPersonalCloudBootstrapPending(storage, scope, true);
    writePersonalStorage(storage, scope, { owner: scope.userId });
  }
  assert.equal(isPersonalCloudBootstrapPending(storage, userA), true);
  assert.equal(isPersonalCloudBootstrapPending(storage, userB), true);
  setPersonalCloudBootstrapPending(storage, userA, false);
  assert.equal(isPersonalCloudBootstrapPending(storage, userA), false);
  assert.equal(isPersonalCloudBootstrapPending(storage, userB), true);
  setPersonalCloudBootstrapPending(storage, userA, true);
  removePersonalStorage(storage, userA);
  assert.equal(isPersonalCloudBootstrapPending(storage, userA), false);
  assert.equal(readPersonalStorage(storage, userA), null);
  assert.equal(isPersonalCloudBootstrapPending(storage, userB), true);
  assert.deepEqual(readPersonalStorage(storage, userB), { owner: "user-b" });
});

test("anonymous and invalid user scopes cannot receive account bootstrap markers", () => {
  const storage = memoryStorage();
  for (const scope of [anonymousPersonalScope, { kind: "user", userId: "   " } as const]) {
    setPersonalCloudBootstrapPending(storage, scope, true);
    assert.equal(isPersonalCloudBootstrapPending(storage, scope), false);
  }
  assert.equal(storage.values.size, 0);
});
