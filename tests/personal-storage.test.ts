import assert from "node:assert/strict";
import test from "node:test";
import {
  anonymousPersonalScope,
  migrateLegacyPersonalStorage,
  personalStorageKey,
  readPersonalStorage,
  removePersonalStorage,
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
