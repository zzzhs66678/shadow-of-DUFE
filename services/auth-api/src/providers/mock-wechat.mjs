import {
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

function sign(value, secret) {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

function equalText(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function validMockSubject(value) {
  return /^[a-z0-9][a-z0-9_-]{2,63}$/i.test(value);
}

export function createMockWechatProvider(config) {
  const callbackUrl =
    `${config.publicOrigin}/api/auth/wechat/callback`;

  return {
    id: "wechat_mock",
    mode: "mock",

    acceptsSecret(value) {
      return value && equalText(value, config.mockLoginSecret);
    },

    createAuthorizationUrl({ state }) {
      const url = new URL("/api/auth/mock/authorize", config.publicOrigin);
      url.searchParams.set("state", state);
      return url.toString();
    },

    createMockCallbackUrl({ state, subject }) {
      if (!validMockSubject(subject)) {
        throw new Error("Invalid mock identity subject");
      }

      const issuedAt = Math.floor(Date.now() / 1000);
      const payload = Buffer.from(
        JSON.stringify({
          sub: subject,
          name: "微信测试同学",
          iat: issuedAt,
          exp: issuedAt + config.oauthTtlSeconds,
          jti: randomBytes(16).toString("base64url"),
        }),
      ).toString("base64url");
      const code = `${payload}.${sign(payload, config.mockLoginSecret)}`;
      const url = new URL(callbackUrl);
      url.searchParams.set("code", code);
      url.searchParams.set("state", state);
      return url.toString();
    },

    async exchangeCode({ code }) {
      if (typeof code !== "string" || code.length > 2048) {
        throw new Error("Invalid mock authorization code");
      }

      const [payload, signature, extra] = code.split(".");
      if (!payload || !signature || extra) {
        throw new Error("Malformed mock authorization code");
      }
      if (!equalText(signature, sign(payload, config.mockLoginSecret))) {
        throw new Error("Invalid mock authorization code signature");
      }

      let decoded;
      try {
        decoded = JSON.parse(Buffer.from(payload, "base64url").toString());
      } catch {
        throw new Error("Invalid mock authorization code payload");
      }

      const now = Math.floor(Date.now() / 1000);
      if (
        !validMockSubject(decoded.sub) ||
        !Number.isInteger(decoded.iat) ||
        !Number.isInteger(decoded.exp) ||
        decoded.iat > now + 30 ||
        decoded.exp < now
      ) {
        throw new Error("Expired or invalid mock authorization code");
      }

      return {
        subject: decoded.sub,
        unionId: null,
        displayName: decoded.name || "微信测试同学",
        avatarUrl: null,
        profile: {
          source: "mock",
          nickname: decoded.name || "微信测试同学",
        },
      };
    },
  };
}

export function createDisabledWechatProvider() {
  return {
    id: "wechat",
    mode: "disabled",
    acceptsSecret() {
      return false;
    },
    createAuthorizationUrl() {
      throw new Error("WeChat authorization is not enabled");
    },
    async exchangeCode() {
      throw new Error("WeChat authorization is not enabled");
    },
  };
}

export function createWechatProvider(config) {
  return config.wechatMode === "mock"
    ? createMockWechatProvider(config)
    : createDisabledWechatProvider();
}
