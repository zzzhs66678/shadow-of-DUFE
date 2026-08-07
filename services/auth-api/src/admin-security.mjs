import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const TOTP_PERIOD_SECONDS = 30;
const TOTP_DIGITS = 6;

function encodeBase32(input) {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of input) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

function decodeBase32(value) {
  const normalized = String(value).toUpperCase().replace(/=+$/u, "");
  if (!normalized || !/^[A-Z2-7]+$/u.test(normalized)) {
    throw new Error("TOTP secret is not valid base32");
  }
  let bits = 0;
  let buffer = 0;
  const output = [];
  for (const character of normalized) {
    buffer = (buffer << 5) | BASE32_ALPHABET.indexOf(character);
    bits += 5;
    if (bits >= 8) {
      output.push((buffer >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}

function counterBuffer(step) {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(step));
  return buffer;
}

function codeForStep(secret, step) {
  const digest = createHmac("sha1", decodeBase32(secret))
    .update(counterBuffer(step))
    .digest();
  const offset = digest.at(-1) & 0x0f;
  const binary = digest.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, "0");
}

function safeCodeEqual(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function normalizeRecoveryCode(code) {
  return String(code).trim().toUpperCase().replaceAll("-", "");
}

function parseEncryptionKeys(keyring) {
  if (!keyring || Array.isArray(keyring) || typeof keyring !== "object") {
    throw new Error("admin MFA keyring must be an object");
  }
  return new Map(
    Object.entries(keyring).map(([keyId, encoded]) => {
      const key = Buffer.from(String(encoded), "base64");
      if (
        !/^[A-Za-z0-9._-]{1,48}$/u.test(keyId) ||
        key.length !== 32 ||
        key.toString("base64") !== encoded
      ) {
        throw new Error("admin MFA keyring contains an invalid key");
      }
      return [keyId, key];
    }),
  );
}

export function createAdminSecurity({
  activeKeyId,
  keyring,
  recoveryPepper,
  now = Date.now,
}) {
  const keys = parseEncryptionKeys(keyring);
  if (!keys.has(activeKeyId)) {
    throw new Error("active admin MFA key is not present in the keyring");
  }
  if (typeof recoveryPepper !== "string" || recoveryPepper.length < 32) {
    throw new Error("admin recovery codes require a separate strong pepper");
  }

  const encryptionContext = ({ factorId, userId }) =>
    Buffer.from(`admin-mfa:${factorId}:${userId}:totp:v1`, "utf8");

  const encryptSecret = (secret, context) => {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", keys.get(activeKeyId), iv);
    cipher.setAAD(encryptionContext(context));
    const encrypted = Buffer.concat([
      cipher.update(secret, "utf8"),
      cipher.final(),
    ]);
    return {
      keyId: activeKeyId,
      encryptedSecret: encrypted.toString("base64"),
      secretIv: iv.toString("base64"),
      secretAuthTag: cipher.getAuthTag().toString("base64"),
    };
  };

  const decryptSecret = (
    { keyId, encryptedSecret, secretIv, secretAuthTag },
    context,
  ) => {
    const key = keys.get(keyId);
    if (!key) throw new Error("admin MFA key is unavailable");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(secretIv, "base64"),
    );
    decipher.setAAD(encryptionContext(context));
    decipher.setAuthTag(Buffer.from(secretAuthTag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(encryptedSecret, "base64")),
      decipher.final(),
    ]).toString("utf8");
  };

  const hashRecoveryCode = (code) =>
    createHmac("sha256", recoveryPepper)
      .update(`admin-recovery:${normalizeRecoveryCode(code)}`)
      .digest("hex");

  return {
    createEnrollment({ userId, accountLabel, issuer = "东财之影" }) {
      if (typeof userId !== "string" || userId.length === 0) {
        throw new Error("admin enrollment requires a user ID");
      }
      const factorId = randomUUID();
      const secret = encodeBase32(randomBytes(20));
      const recoveryCodes = Array.from({ length: 10 }, () => {
        const raw = encodeBase32(randomBytes(16));
        return [0, 5, 10, 15, 20]
          .map((start) => raw.slice(start, start + (start === 20 ? 6 : 5)))
          .join("-");
      });
      const label = encodeURIComponent(`${issuer}:${accountLabel}`);
      const query = new URLSearchParams({
        secret,
        issuer,
        algorithm: "SHA1",
        digits: String(TOTP_DIGITS),
        period: String(TOTP_PERIOD_SECONDS),
      });
      return {
        factorId,
        secret,
        otpauthUri: `otpauth://totp/${label}?${query}`,
        recoveryCodes,
        recoveryCodeHashes: recoveryCodes.map(hashRecoveryCode),
        encrypted: encryptSecret(secret, { factorId, userId }),
      };
    },

    verifyTotp(encrypted, context, code, lastTotpStep = null) {
      const normalizedCode = String(code).trim();
      if (!/^\d{6}$/u.test(normalizedCode)) return null;
      const secret = decryptSecret(encrypted, context);
      const currentStep = Math.floor(now() / 1_000 / TOTP_PERIOD_SECONDS);
      for (const candidateStep of [currentStep, currentStep - 1, currentStep + 1]) {
        if (lastTotpStep !== null && candidateStep <= Number(lastTotpStep)) {
          continue;
        }
        if (safeCodeEqual(codeForStep(secret, candidateStep), normalizedCode)) {
          return candidateStep;
        }
      }
      return null;
    },

    hashRecoveryCode,
  };
}

export const __test = {
  codeForStep,
  decodeBase32,
  encodeBase32,
  normalizeRecoveryCode,
};
