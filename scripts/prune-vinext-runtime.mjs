import { access, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";

const root = process.cwd();
const reviewedPackages = new Map([
  ["node_modules/braces", "3.0.3"],
  ["node_modules/micromatch", "4.0.8"],
  ["node_modules/vite-plugin-commonjs", "0.10.4"],
  ["node_modules/vite-plugin-dynamic-import", "1.6.0"],
  ["node_modules/vite-plugin-dynamic-import/node_modules/fast-glob", "3.3.3"],
]);

async function packageVersion(relativeDirectory) {
  const manifest = JSON.parse(
    await readFile(resolve(root, relativeDirectory, "package.json"), "utf8"),
  );
  return manifest.version;
}

for (const [relativeDirectory, expectedVersion] of reviewedPackages) {
  const actualVersion = await packageVersion(relativeDirectory);
  if (actualVersion !== expectedVersion) {
    throw new Error(
      `Refusing to prune unreviewed ${relativeDirectory} version ${actualVersion}; expected ${expectedVersion}`,
    );
  }
}

// vinext's generic build plugin imports this chain, while server.mjs imports the
// separate production-server export. The image smoke test proves that export and
// a real HTTP request still work after these exact directories are removed.
for (const relativeDirectory of [
  "node_modules/vite-plugin-commonjs",
  "node_modules/vite-plugin-dynamic-import",
  "node_modules/micromatch",
  "node_modules/braces",
]) {
  await rm(resolve(root, relativeDirectory), { recursive: true, force: false });
}

for (const relativeDirectory of reviewedPackages.keys()) {
  try {
    await access(resolve(root, relativeDirectory));
    throw new Error(`Runtime build dependency remains present: ${relativeDirectory}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

console.log("Removed the reviewed vinext build-plugin chain from the runtime image.");
