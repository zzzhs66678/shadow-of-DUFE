import { startProdServer } from "./node_modules/vinext/dist/server/prod-server.js";
import { fileURLToPath } from "node:url";

const port = Number.parseInt(process.env.PORT ?? "3000", 10);
const host = process.env.HOSTNAME ?? "0.0.0.0";

await startProdServer({
  port,
  host,
  outDir: fileURLToPath(new URL("./dist", import.meta.url)),
});
