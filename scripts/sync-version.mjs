#!/usr/bin/env node
/*
 * Copies package.json's version into server.json (the MCP Registry entry) so both always match.
 * The running server reports the same version: it reads package.json at startup.
 *
 *   node scripts/sync-version.mjs          rewrite server.json if it's behind
 *   node scripts/sync-version.mjs --check  exit 1 instead of writing (for CI)
 */
import { readFile, writeFile } from "node:fs/promises";

const packageUrl = new URL("../package.json", import.meta.url);
const serverUrl = new URL("../server.json", import.meta.url);
const checkOnly = process.argv.includes("--check");

const packageJson = JSON.parse(await readFile(packageUrl, "utf8"));
const serverJson = JSON.parse(await readFile(serverUrl, "utf8"));

if (serverJson.name !== packageJson.mcpName) {
  console.error(`server.json name "${serverJson.name}" must equal package.json mcpName "${packageJson.mcpName}".`);
  process.exit(1);
}
const npmPackages = (serverJson.packages ?? []).filter((entry) => entry.registryType === "npm" && entry.identifier === packageJson.name);
if (npmPackages.length !== 1) {
  console.error(`server.json must list ${packageJson.name} exactly once under packages.`);
  process.exit(1);
}

const stale = [serverJson.version, npmPackages[0].version].some((version) => version !== packageJson.version);
if (!stale) {
  console.log(`server.json is at ${packageJson.version}.`);
} else if (checkOnly) {
  console.error(`server.json is at ${serverJson.version}, package.json at ${packageJson.version}. Run: node scripts/sync-version.mjs`);
  process.exit(1);
} else {
  serverJson.version = packageJson.version;
  npmPackages[0].version = packageJson.version;
  await writeFile(serverUrl, `${JSON.stringify(serverJson, null, 2)}\n`);
  console.log(`server.json updated to ${packageJson.version}.`);
}
