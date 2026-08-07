import { loadConfig } from "./config.mjs";
import { createAuthStore, createDatabasePool } from "./db.mjs";
import { createWechatProvider } from "./providers/mock-wechat.mjs";
import { createPasswordService } from "./passwords.mjs";
import { createAvatarProcessor } from "./avatars.mjs";
import { createAuthServer } from "./server.mjs";

const config = loadConfig();
const pool = createDatabasePool(config);
const store = createAuthStore(pool);
const wechatProvider = createWechatProvider(config);
const passwordService = createPasswordService();
const avatarProcessor = createAvatarProcessor();
const server = createAuthServer({
  store,
  config,
  wechatProvider,
  passwordService,
  avatarProcessor,
});

server.listen(config.port, "0.0.0.0", () => {
  console.log(`Dufesh auth API listening on port ${config.port}`);
});

async function shutdown(signal) {
  console.log(`Received ${signal}; closing auth API`);
  server.close(async () => {
    await store.close();
    process.exit(0);
  });

  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
