#!/usr/bin/env node
/*
 * Copies package.json's version into server.json (the MCP Registry entry), manifest.json (the MCPB bundle for
 * Claude Desktop and Smithery), and plugin.json (the agent plugin) so all of them always match.
 * The running server reports the same version: it reads package.json at startup.
 *
 *   node scripts/sync-version.mjs          rewrite the files that are behind
 *   node scripts/sync-version.mjs --check  exit 1 instead of writing (for CI)
 */
import { readFile, writeFile } from "node:fs/promises";

const packageUrl = new URL("../package.json", import.meta.url);
const checkOnly = process.argv.includes("--check");

const packageJson = JSON.parse(await readFile(packageUrl, "utf8"));
const readJson = async (fileName) => JSON.parse(await readFile(new URL(`../${fileName}`, import.meta.url), "utf8"));

const serverJson = await readJson("server.json");
if (serverJson.name !== packageJson.mcpName) {
  console.error(`server.json name "${serverJson.name}" must equal package.json mcpName "${packageJson.mcpName}".`);
  process.exit(1);
}
const npmPackages = (serverJson.packages ?? []).filter((entry) => entry.registryType === "npm" && entry.identifier === packageJson.name);
if (npmPackages.length !== 1) {
  console.error(`server.json must list ${packageJson.name} exactly once under packages.`);
  process.exit(1);
}

const manifestJson = await readJson("manifest.json");
const pluginJson = await readJson("plugin.json");

/** Each file, and the objects in it whose `version` must equal package.json's. */
const targets = [
  { fileName: "server.json", json: serverJson, versioned: [serverJson, npmPackages[0]] },
  { fileName: "manifest.json", json: manifestJson, versioned: [manifestJson] },
  { fileName: "plugin.json", json: pluginJson, versioned: [pluginJson] },
];
for (const { fileName, versioned } of targets) {
  if (versioned.some((entry) => typeof entry.version !== "string")) {
    console.error(`${fileName} must have a string "version".`);
    process.exit(1);
  }
}

let failed = false;
for (const { fileName, json, versioned } of targets) {
  const stale = versioned.some((entry) => entry.version !== packageJson.version);
  if (!stale) {
    console.log(`${fileName} is at ${packageJson.version}.`);
  } else if (checkOnly) {
    console.error(`${fileName} is at ${json.version}, package.json at ${packageJson.version}. Run: node scripts/sync-version.mjs`);
    failed = true;
  } else {
    for (const entry of versioned) entry.version = packageJson.version;
    await writeFile(new URL(`../${fileName}`, import.meta.url), `${JSON.stringify(json, null, 2)}\n`);
    console.log(`${fileName} updated to ${packageJson.version}.`);
  }
}
if (failed) process.exit(1);
