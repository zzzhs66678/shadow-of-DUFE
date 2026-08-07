import { Algorithm, hash, verify } from "@node-rs/argon2";

const ARGON2ID_OPTIONS = Object.freeze({
  algorithm: Algorithm.Argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
});

export function createPasswordService() {
  return {
    hash(password) {
      return hash(password, ARGON2ID_OPTIONS);
    },
    verify(passwordHash, password) {
      return verify(passwordHash, password);
    },
  };
}
