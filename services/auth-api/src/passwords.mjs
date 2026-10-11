import { Algorithm, hash, verify } from "@node-rs/argon2";

const ARGON2ID_OPTIONS = Object.freeze({
  algorithm: Algorithm.Argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
});

export function createPasswordService() {
  let active = 0;
  async function bounded(operation) {
    if (active >= 2) {
      const error = new Error("Password service busy");
      error.code = "AUTH_PASSWORD_BUSY";
      throw error;
    }
    active += 1;
    try { return await operation(); } finally { active -= 1; }
  }
  return {
    hash(password) {
      return bounded(() => hash(password, ARGON2ID_OPTIONS));
    },
    verify(passwordHash, password) {
      return bounded(() => verify(passwordHash, password));
    },
  };
}
