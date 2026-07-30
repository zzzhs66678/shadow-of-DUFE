import { createHash, randomBytes, randomUUID } from "node:crypto";

const DEFAULT_TTL_MS = 10 * 60_000;
const MAX_ATTEMPTS = 5;

function tokenHash(token) {
  return createHash("sha256").update(token).digest("hex");
}

function normalizeBaseUrl(value) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("授权地址必须使用 HTTP 或 HTTPS");
  }
  return url.toString().replace(/\/$/, "");
}

export class PairingService {
  constructor({ clock = () => Date.now(), ttlMs = DEFAULT_TTL_MS } = {}) {
    this.clock = clock;
    this.ttlMs = ttlMs;
    this.sessions = new Map();
  }

  create({ userId, publicBaseUrl, purpose = "traceint" }) {
    this.#purge();
    const token = randomBytes(32).toString("base64url");
    const id = randomUUID();
    const createdAt = this.clock();
    const expiresAt = createdAt + this.ttlMs;
    const session = {
      id,
      userId,
      purpose,
      tokenHash: tokenHash(token),
      status: "pending",
      attempts: 0,
      createdAt,
      expiresAt,
      completedAt: null,
      errorCode: null,
    };
    this.sessions.set(id, session);
    return {
      id,
      token,
      mobileUrl: `${normalizeBaseUrl(publicBaseUrl)}/pair?token=${encodeURIComponent(token)}`,
      status: session.status,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  getForUser(id, userId) {
    this.#purge();
    const session = this.sessions.get(String(id));
    if (!session || session.userId !== userId) return null;
    return this.#publicSession(session);
  }

  getByToken(token) {
    this.#purge();
    const digest = tokenHash(String(token ?? ""));
    for (const session of this.sessions.values()) {
      if (session.tokenHash === digest) return session;
    }
    return null;
  }

  async submit({ token, authorization, complete }) {
    const session = this.getByToken(token);
    if (!session || session.status === "expired") {
      throw new PairingError("PAIRING_EXPIRED", "这个授权码已经失效，请回到电脑端重新生成");
    }
    if (session.status === "completed") {
      return this.#publicSession(session);
    }
    if (session.status === "processing") {
      throw new PairingError("PAIRING_BUSY", "授权正在处理，请稍等");
    }
    if (session.attempts >= MAX_ATTEMPTS) {
      session.status = "expired";
      throw new PairingError("PAIRING_ATTEMPTS_EXCEEDED", "尝试次数过多，请重新生成二维码");
    }

    session.attempts += 1;
    session.status = "processing";
    session.errorCode = null;
    try {
      await complete(session, authorization);
      session.status = "completed";
      session.completedAt = this.clock();
      return this.#publicSession(session);
    } catch (error) {
      session.status = "pending";
      session.errorCode = "AUTHORIZATION_REJECTED";
      throw error;
    }
  }

  cancel(id, userId) {
    const session = this.sessions.get(String(id));
    if (!session || session.userId !== userId) return false;
    this.sessions.delete(session.id);
    return true;
  }

  #purge() {
    const now = this.clock();
    for (const session of this.sessions.values()) {
      if (session.expiresAt <= now && session.status !== "completed") {
        session.status = "expired";
      }
      if (session.expiresAt + 60 * 60_000 <= now) {
        this.sessions.delete(session.id);
      }
    }
  }

  #publicSession(session) {
    return {
      id: session.id,
      purpose: session.purpose,
      status: session.status,
      expiresAt: new Date(session.expiresAt).toISOString(),
      completedAt: session.completedAt
        ? new Date(session.completedAt).toISOString()
        : null,
      errorCode: session.errorCode,
    };
  }
}

export class PairingError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PairingError";
    this.code = code;
  }
}
