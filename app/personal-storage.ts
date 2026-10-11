export type PersonalStorageScope =
  | { kind: "anonymous" }
  | { kind: "user"; userId: string };

export type PersonalStorage = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem"
>;

const LEGACY_PERSONAL_STORAGE_KEY = "dufesh:student-profile:v2";
const PERSONAL_STORAGE_PREFIX = "dufesh:student-profile:v3";

export const anonymousPersonalScope: PersonalStorageScope = {
  kind: "anonymous",
};

export function userPersonalScope(userId: string): PersonalStorageScope {
  const normalized = userId.trim();
  if (!normalized) throw new Error("userId is required for account storage");
  return { kind: "user", userId: normalized };
}

export function personalStorageKey(scope: PersonalStorageScope) {
  return scope.kind === "anonymous"
    ? `${PERSONAL_STORAGE_PREFIX}:anonymous`
    : `${PERSONAL_STORAGE_PREFIX}:user:${encodeURIComponent(scope.userId)}`;
}

export function migrateLegacyPersonalStorage(storage: PersonalStorage) {
  const legacy = storage.getItem(LEGACY_PERSONAL_STORAGE_KEY);
  if (legacy === null) return false;

  const anonymousKey = personalStorageKey(anonymousPersonalScope);
  if (storage.getItem(anonymousKey) === null) {
    storage.setItem(anonymousKey, legacy);
  }
  storage.removeItem(LEGACY_PERSONAL_STORAGE_KEY);
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
}
