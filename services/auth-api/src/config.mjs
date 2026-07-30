function positiveInteger(value, fallback, name) {
  const parsed = Number.parseInt(value ?? "", 10);
  const resolved = Number.isFinite(parsed) ? parsed : fallback;
  if (resolved <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return resolved;
}

export function loadConfig(env = process.env) {
  const tokenPepper = env.AUTH_TOKEN_PEPPER ?? "";
  if (tokenPepper.length < 32) {
    throw new Error("AUTH_TOKEN_PEPPER must contain at least 32 characters");
  }
  if (!env.POSTGRES_PASSWORD) {
    throw new Error("POSTGRES_PASSWORD is required");
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

  return {
    port: positiveInteger(env.AUTH_API_PORT, 3100, "AUTH_API_PORT"),
    tokenPepper,
    allowedOrigins,
    sessionCookie: env.AUTH_SESSION_COOKIE || "__Host-dufesh_session",
    deviceCookie: env.AUTH_DEVICE_COOKIE || "__Host-dufesh_device",
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
    poolMax: Math.min(
      positiveInteger(env.AUTH_DB_POOL_MAX, 10, "AUTH_DB_POOL_MAX"),
      20,
    ),
    database: {
      host: env.PGHOST || "postgres",
      port: positiveInteger(env.PGPORT, 5432, "PGPORT"),
      database: env.POSTGRES_DB || "dufesh",
      user: env.POSTGRES_USER || "dufesh_app",
      password: env.POSTGRES_PASSWORD,
    },
  };
}
