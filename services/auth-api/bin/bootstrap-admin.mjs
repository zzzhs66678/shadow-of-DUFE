import { createAdminSecurity } from "../src/admin-security.mjs";
import { loadConfig } from "../src/config.mjs";
import { normalizeLoginIdentifier } from "../src/credentials.mjs";
import { createAuthStore, createDatabasePool } from "../src/db.mjs";

const args = process.argv.slice(2);
const rotate = args.includes("--rotate");
const identifier = args.find((argument) => !argument.startsWith("--"));

if (!identifier) {
  console.error(
    "Usage: npm run admin:bootstrap -- <username-or-email> [--rotate]",
  );
  process.exitCode = 2;
} else {
  const config = loadConfig();
  if (!config.adminEnabled) {
    throw new Error("AUTH_ADMIN_ENABLED must be true before bootstrapping an admin");
  }

  const pool = createDatabasePool(config);
  try {
    const store = createAuthStore(pool);
    const target = await store.getAdminBootstrapTarget(
      normalizeLoginIdentifier(identifier),
    );
    if (!target || target.status !== "active") {
      throw new Error("No active account matches that username or email");
    }
    if (target.mfaConfigured && !rotate) {
      throw new Error(
        "This account already has administrator MFA; pass --rotate to replace it",
      );
    }

    const security = createAdminSecurity({
      activeKeyId: config.adminMfaActiveKeyId,
      keyring: config.adminMfaKeys,
      recoveryPepper: config.adminRecoveryPepper,
    });
    const enrollment = security.createEnrollment({
      userId: target.id,
      accountLabel: target.email || target.username || target.id,
    });
    await store.bootstrapAdmin({ userId: target.id, enrollment, rotate });

    console.log("Administrator MFA configured. Existing sessions were revoked.");
    console.log(`Account: ${target.username || target.email || target.id}`);
    console.log(`TOTP secret: ${enrollment.secret}`);
    console.log(`Authenticator URI: ${enrollment.otpauthUri}`);
    console.log("Recovery codes (shown once):");
    for (const code of enrollment.recoveryCodes) console.log(code);
  } finally {
    await pool.end();
  }
}
