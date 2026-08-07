function positiveInteger(value, fallback, name) {
  const parsed = Number.parseInt(value ?? "", 10);
  const resolved = Number.isFinite(parsed) ? parsed : fallback;
  if (resolved <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return resolved;
}

function booleanValue(value, fallback, name) {
  if (value === undefined || value === "") return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false`);
}

function adminKeyring(value, activeKeyId) {
  let parsed;
  try {
    parsed = JSON.parse(value || "{}");
  } catch {
    throw new Error("AUTH_ADMIN_MFA_KEYS must be a JSON object");
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("AUTH_ADMIN_MFA_KEYS must be a JSON object");
  }
  const entries = Object.entries(parsed);
  for (const [keyId, encoded] of entries) {
    const decoded = Buffer.from(String(encoded), "base64");
    if (
      !/^[A-Za-z0-9._-]{1,48}$/u.test(keyId) ||
      decoded.length !== 32 ||
      decoded.toString("base64") !== encoded
    ) {
      throw new Error(
        "AUTH_ADMIN_MFA_KEYS must map safe key IDs to exactly 32 base64-encoded bytes",
      );
    }
  }
  if (!activeKeyId || !Object.hasOwn(parsed, activeKeyId)) {
    throw new Error("AUTH_ADMIN_MFA_ACTIVE_KEY_ID must select a configured key");
  }
  return parsed;
}

export function loadConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV || "development";
  const tokenPepper = env.AUTH_TOKEN_PEPPER ?? "";
  if (tokenPepper.length < 32) {
    throw new Error("AUTH_TOKEN_PEPPER must contain at least 32 characters");
  }
  const databasePassword = env.AUTH_DB_PASSWORD || env.POSTGRES_PASSWORD;
  if (!databasePassword) {
    throw new Error("AUTH_DB_PASSWORD or POSTGRES_PASSWORD is required");
  }

  const publicOrigin = new URL(
    env.AUTH_PUBLIC_ORIGIN || "https://dufesh.cn",
  );
  if (publicOrigin.protocol !== "https:" || publicOrigin.pathname !== "/") {
    throw new Error("AUTH_PUBLIC_ORIGIN must be an HTTPS origin without a path");
  }

  const wechatMode = env.AUTH_WECHAT_MODE || "disabled";
  if (!["disabled", "mock"].includes(wechatMode)) {
    throw new Error("AUTH_WECHAT_MODE must be disabled or mock");
  }

  const mockLoginSecret = env.AUTH_MOCK_LOGIN_SECRET || "";
  if (wechatMode === "mock" && mockLoginSecret.length < 32) {
    throw new Error(
      "AUTH_MOCK_LOGIN_SECRET must contain at least 32 characters in mock mode",
    );
  }

  const allowedOrigins = new Set(
    (env.AUTH_ALLOWED_ORIGINS ?? "https://dufesh.cn,https://www.dufesh.cn")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );

  if (allowedOrigins.size === 0) {
    throw new Error("AUTH_ALLOWED_ORIGINS must not be empty");
  }

  const passwordResetMode =
    env.AUTH_PASSWORD_RESET_MODE ||
    (nodeEnv === "production" ? "disabled" : "response");
  if (!["disabled", "response"].includes(passwordResetMode)) {
    throw new Error("AUTH_PASSWORD_RESET_MODE must be disabled or response");
  }
  if (nodeEnv === "production" && passwordResetMode === "response") {
    throw new Error(
      "AUTH_PASSWORD_RESET_MODE=response is forbidden in production",
    );
  }

  const emailVerificationMode =
    env.AUTH_EMAIL_VERIFICATION_MODE ||
    (nodeEnv === "production" ? "disabled" : "response");
  if (!["disabled", "response"].includes(emailVerificationMode)) {
    throw new Error(
      "AUTH_EMAIL_VERIFICATION_MODE must be disabled or response",
    );
  }
  if (nodeEnv === "production" && emailVerificationMode === "response") {
    throw new Error(
      "AUTH_EMAIL_VERIFICATION_MODE=response is forbidden in production",
    );
  }

  const adminEnabled = booleanValue(
    env.AUTH_ADMIN_ENABLED,
    false,
    "AUTH_ADMIN_ENABLED",
  );
  const adminMfaActiveKeyId = String(
    env.AUTH_ADMIN_MFA_ACTIVE_KEY_ID ?? "",
  ).trim();
  const adminRecoveryPepper = String(
    env.AUTH_ADMIN_RECOVERY_PEPPER ?? "",
  );
  let adminMfaKeys = {};
  if (adminEnabled) {
    adminMfaKeys = adminKeyring(
      env.AUTH_ADMIN_MFA_KEYS,
      adminMfaActiveKeyId,
    );
    if (adminRecoveryPepper.length < 32) {
      throw new Error(
        "AUTH_ADMIN_RECOVERY_PEPPER must contain at least 32 characters when admin access is enabled",
      );
    }
  }

  return {
    port: positiveInteger(env.AUTH_API_PORT, 3100, "AUTH_API_PORT"),
    tokenPepper,
    allowedOrigins,
    sessionCookie: env.AUTH_SESSION_COOKIE || "__Host-dufesh_session",
    deviceCookie: env.AUTH_DEVICE_COOKIE || "__Host-dufesh_device",
    oauthCookie: env.AUTH_OAUTH_COOKIE || "__Host-dufesh_oauth",
    sessionMaxAgeSeconds: positiveInteger(
      env.AUTH_SESSION_MAX_AGE_SECONDS,
      60 * 60 * 24 * 30,
      "AUTH_SESSION_MAX_AGE_SECONDS",
    ),
    deviceMaxAgeSeconds: positiveInteger(
      env.AUTH_DEVICE_MAX_AGE_SECONDS,
      60 * 60 * 24 * 365,
      "AUTH_DEVICE_MAX_AGE_SECONDS",
    ),
    oauthTtlSeconds: Math.min(
      positiveInteger(
        env.AUTH_OAUTH_TTL_SECONDS,
        600,
        "AUTH_OAUTH_TTL_SECONDS",
      ),
      900,
    ),
    poolMax: Math.min(
      positiveInteger(env.AUTH_DB_POOL_MAX, 10, "AUTH_DB_POOL_MAX"),
      20,
    ),
    database: {
      host: env.PGHOST || "postgres",
      port: positiveInteger(env.PGPORT, 5432, "PGPORT"),
      database: env.POSTGRES_DB || "dufesh",
      user: env.AUTH_DB_USER || env.POSTGRES_USER || "dufesh_runtime",
      password: databasePassword,
    },
    publicOrigin: publicOrigin.origin,
    credentialsEnabled: booleanValue(
      env.AUTH_CREDENTIALS_ENABLED,
      true,
      "AUTH_CREDENTIALS_ENABLED",
    ),
    passwordResetMode,
    passwordResetTtlSeconds: Math.min(
      positiveInteger(
        env.AUTH_PASSWORD_RESET_TTL_SECONDS,
        1_800,
        "AUTH_PASSWORD_RESET_TTL_SECONDS",
      ),
      3_600,
    ),
    emailVerificationMode,
    emailVerificationTtlSeconds: Math.min(
      positiveInteger(
        env.AUTH_EMAIL_VERIFICATION_TTL_SECONDS,
        86_400,
        "AUTH_EMAIL_VERIFICATION_TTL_SECONDS",
      ),
      86_400,
    ),
    adminEnabled,
    adminCookie:
      env.AUTH_ADMIN_COOKIE || "__Host-dufesh_admin_elevation",
    adminMfaActiveKeyId,
    adminMfaKeys,
    adminRecoveryPepper,
    adminElevationTtlSeconds: Math.min(
      positiveInteger(
        env.AUTH_ADMIN_ELEVATION_TTL_SECONDS,
        600,
        "AUTH_ADMIN_ELEVATION_TTL_SECONDS",
      ),
      900,
    ),
    wechatMode,
    mockLoginSecret,
  };
}
