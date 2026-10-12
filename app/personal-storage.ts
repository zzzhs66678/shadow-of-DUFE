export type PersonalStorageScope =
  | { kind: "anonymous" }
  | { kind: "user"; userId: string };

export type PersonalStorage = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem"
>;

const LEGACY_PERSONAL_STORAGE_KEY = "dufesh:student-profile:v2";
const LEGACY_PERSONAL_STORAGE_BACKUP_KEY = "dufesh:student-profile:v2:migration-backup";
const PERSONAL_STORAGE_PREFIX = "dufesh:student-profile:v3";

export const anonymousPersonalScope: PersonalStorageScope = {
  kind: "anonymous",
};

export function userPersonalScope(userId: string): Extract<PersonalStorageScope, { kind: "user" }> {
  const normalized = userId.trim();
  if (!normalized) throw new Error("userId is required for account storage");
  return { kind: "user", userId: normalized };
}

export function personalStorageKey(scope: PersonalStorageScope) {
  return scope.kind === "anonymous"
    ? `${PERSONAL_STORAGE_PREFIX}:anonymous`
    : `${PERSONAL_STORAGE_PREFIX}:user:${encodeURIComponent(scope.userId)}`;
}

function pendingCloudBootstrapKey(scope: PersonalStorageScope): string | null {
  if (scope.kind !== "user" || typeof scope.userId !== "string" || !scope.userId.trim()) return null;
  return `${personalStorageKey(scope)}:pending-cloud-bootstrap`;
}

export function isPersonalCloudBootstrapPending(
  storage: PersonalStorage,
  scope: PersonalStorageScope,
) {
  const key = pendingCloudBootstrapKey(scope);
  return key !== null && storage.getItem(key) === "1";
}

export function setPersonalCloudBootstrapPending(
  storage: PersonalStorage,
  scope: PersonalStorageScope,
  pending: boolean,
) {
  const key = pendingCloudBootstrapKey(scope);
  if (key === null) return;
  if (pending) storage.setItem(key, "1");
  else storage.removeItem(key);
}

export function migrateLegacyPersonalStorage(storage: PersonalStorage) {
  const legacy = storage.getItem(LEGACY_PERSONAL_STORAGE_KEY);
  if (legacy === null) return false;

  const anonymousKey = personalStorageKey(anonymousPersonalScope);
  if (storage.getItem(anonymousKey) === null) {
    storage.setItem(anonymousKey, legacy);
  }
  // A legacy profile has no account identity. Keep its original bytes for an
  // explicit recovery, including when an anonymous profile already exists.
  try {
    if (storage.getItem(LEGACY_PERSONAL_STORAGE_BACKUP_KEY) === null) {
      storage.setItem(LEGACY_PERSONAL_STORAGE_BACKUP_KEY, legacy);
    }
    storage.removeItem(LEGACY_PERSONAL_STORAGE_KEY);
  } catch {
    // If the extra copy exceeds storage capacity, the source remains intact.
  }
  return true;
}

export function readPersonalStorage<T>(
  storage: PersonalStorage,
  scope: PersonalStorageScope,
): T | null {
  try {
    return JSON.parse(storage.getItem(personalStorageKey(scope)) ?? "null") as
      | T
      | null;
  } catch {
    return null;
  }
}

export function writePersonalStorage(
  storage: PersonalStorage,
  scope: PersonalStorageScope,
  value: unknown,
) {
  storage.setItem(personalStorageKey(scope), JSON.stringify(value));
}

export function removePersonalStorage(
  storage: PersonalStorage,
  scope: PersonalStorageScope,
) {
  storage.removeItem(personalStorageKey(scope));
  setPersonalCloudBootstrapPending(storage, scope, false);
}
