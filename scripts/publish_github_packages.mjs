/**
 * Publish the package to GitHub Packages — the scoped mirror of the npm release.
 *
 * npm carries the public name (opencode-plugin-relay). GitHub Packages' npm
 * registry requires a scoped name (@darkhipo/opencode-plugin-relay) and its own
 * registry (https://npm.pkg.github.com). This publishes the SAME content under
 * the scoped name so the repository's Packages section shows the artifact.
 *
 * The gh CLI token is read once, handed to npm through NODE_AUTH_TOKEN and a
 * temporary .npmrc-github, and never printed. package.json is restored
 * byte-for-byte in a finally block, so a failed publish cannot leave the scoped
 * name behind in the working tree.
 *
 * Usage: npm run publish:github
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GH_REGISTRY = "https://npm.pkg.github.com";
const SCOPED = "@darkhipo/opencode-plugin-relay";
const PKG = join(ROOT, "package.json");
const NPMRC = join(ROOT, ".npmrc-github");

function die(msg) {
  console.error(`publish:github: ${msg}`);
  process.exit(1);
}

let token = "";
try {
  token = execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
} catch (err) {
  die(`could not read a gh token (gh auth token failed): ${err.message}`);
}
if (!token) die("gh is not authenticated — run `gh auth login`");

// Keep the exact original text so the restore is byte-for-byte, not a re-serialise.
const originalText = readFileSync(PKG, "utf8");
const pkg = JSON.parse(originalText);

writeFileSync(NPMRC, `@darkhipo:registry=${GH_REGISTRY}\n//npm.pkg.github.com/:_authToken=${token}\n`, {
  mode: 0o600,
});

try {
  writeFileSync(
    PKG,
    `${JSON.stringify({ ...pkg, name: SCOPED, publishConfig: { registry: GH_REGISTRY } }, null, 2)}\n`,
  );
  console.log(`publishing ${SCOPED}@${pkg.version} to GitHub Packages...`);

  const r = spawnSync(
    "npm",
    ["publish", "--registry", GH_REGISTRY, "--userconfig", NPMRC, "--ignore-scripts"],
    { cwd: ROOT, encoding: "utf8", env: { ...process.env, NODE_AUTH_TOKEN: token } },
  );
  const out = `${r.stdout || ""}${r.stderr || ""}`.trim();
  console.log(out.slice(-400));

  const ok = r.status === 0 && out.includes("opencode-plugin-relay");
  console.log(`RESULT: ${ok ? "PUBLISHED" : "FAILED"}`);
  process.exitCode = ok ? 0 : 1;
} finally {
  writeFileSync(PKG, originalText);
  if (existsSync(NPMRC)) unlinkSync(NPMRC);
}
