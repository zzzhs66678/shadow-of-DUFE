import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";

const KEY_BYTES = 32;
const IV_BYTES = 12;

export async function loadOrCreateMasterKey(keyPath, encodedEnvironmentKey = "") {
  if (encodedEnvironmentKey) {
    const key = Buffer.from(encodedEnvironmentKey, "base64");
    if (key.length !== KEY_BYTES) {
      throw new Error("XIAOYING_MASTER_KEY 必须是 32 字节密钥的 Base64");
    }
    return key;
  }

  await mkdir(dirname(keyPath), { recursive: true });
  try {
    const existing = Buffer.from((await readFile(keyPath, "utf8")).trim(), "base64");
    if (existing.length !== KEY_BYTES) throw new Error("本地主密钥格式不正确");
    return existing;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const generated = randomBytes(KEY_BYTES);
  try {
    const handle = await open(keyPath, "wx", 0o600);
    await handle.writeFile(generated.toString("base64"), "utf8");
    await handle.close();
    return generated;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const existing = Buffer.from((await readFile(keyPath, "utf8")).trim(), "base64");
    if (existing.length !== KEY_BYTES) throw new Error("本地主密钥格式不正确");
    return existing;
  }
}

export function encryptSecret(plaintext, masterKey, associatedData) {
  const value = typeof plaintext === "string" ? plaintext.trim() : "";
  if (!value) throw new Error("密钥不能为空");
  if (!Buffer.isBuffer(masterKey) || masterKey.length !== KEY_BYTES) {
    throw new Error("主密钥无效");
  }

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", masterKey, iv);
  cipher.setAAD(Buffer.from(associatedData, "utf8"));
  const ciphertext = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);

  return {
    algorithm: "aes-256-gcm",
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    last4: value.slice(-4),
  };
}

export function decryptSecret(record, masterKey, associatedData) {
  if (record?.algorithm !== "aes-256-gcm") {
    throw new Error("不支持的密钥加密格式");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    masterKey,
    Buffer.from(record.iv, "base64"),
  );
  decipher.setAAD(Buffer.from(associatedData, "utf8"));
  decipher.setAuthTag(Buffer.from(record.tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(record.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}
