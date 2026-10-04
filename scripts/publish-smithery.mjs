#!/usr/bin/env node
/*
 * Publishes build/dropl.mcpb to Smithery as a local stdio server, with the server card from build/server-card.json.
 * Use it instead of `smithery mcp publish ./build/dropl.mcpb`, whose card has no tool inputSchemas (see
 * smithery-payload.mjs). It makes the same API calls as the Smithery CLI: create the server (idempotent), upload the
 * release, then follow its status. Run `pnpm bundle` first.
 *
 *   SMITHERY_API_KEY=… node scripts/publish-smithery.mjs --name isaias/dropl
 *   node scripts/publish-smithery.mjs --name isaias/dropl --dry-run   check and print the payload; send nothing
 */
import { createReadStream } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Smithery } from "@smithery/api";
import { buildSmitheryPayload } from "./smithery-payload.mjs";

const API_KEYS_URL = "https://smithery.ai/account/api-keys";
const STATUS_POLL_INTERVAL_MS = 2_000;
const MS_PER_MINUTE = 60 * 1_000;
const STATUS_TIMEOUT_MS = 10 * MS_PER_MINUTE;
const FAILED_STATUSES = new Set(["FAILURE", "FAILURE_SCAN", "INTERNAL_ERROR", "CANCELLED"]);
const BYTES_PER_KILOBYTE = 1_000;

const bundleUrl = new URL("../build/dropl.mcpb", import.meta.url);
const stagedManifestUrl = new URL("../build/mcpb/manifest.json", import.meta.url);
const serverCardUrl = new URL("../build/server-card.json", import.meta.url);
const payloadUrl = new URL("../build/smithery-payload.json", import.meta.url);

const { values } = parseArgs({ options: { name: { type: "string", short: "n" }, "dry-run": { type: "boolean" } } });
const qualifiedName = values.name?.trim();
if (!qualifiedName || !/^[\w.-]+\/[\w.-]+$/.test(qualifiedName)) {
  console.error("Pass the Smithery server as --name <namespace>/<server>, e.g. --name isaias/dropl.");
  process.exit(1);
}

const readJson = async (url) => JSON.parse(await readFile(url, "utf8"));
let manifest;
let serverCard;
let bundleSize;
try {
  [manifest, serverCard, { size: bundleSize }] = await Promise.all([readJson(stagedManifestUrl), readJson(serverCardUrl), stat(bundleUrl)]);
} catch (error) {
  console.error(`Missing bundle output (${error instanceof Error ? error.message : String(error)}). Run: pnpm --filter @dropl/mcp bundle`);
  process.exit(1);
}
const packageJson = await readJson(new URL("../package.json", import.meta.url));
if (manifest.version !== packageJson.version) {
  console.error(`build/ holds ${manifest.version}, package.json is at ${packageJson.version}. Run: pnpm --filter @dropl/mcp bundle`);
  process.exit(1);
}
const payload = buildSmitheryPayload(manifest, serverCard);

console.log(`Smithery release for ${qualifiedName}: ${payload.type}/${payload.runtime}, ${payload.serverCard.serverInfo.name} ${payload.serverCard.serverInfo.version}`);
console.log(`  tools: ${payload.serverCard.tools.length}, all with an inputSchema`);
console.log(`  configSchema: ${Object.keys(payload.configSchema?.properties ?? {}).join(", ") || "none"}`);
console.log(`  bundle: ${fileURLToPath(bundleUrl)} (${(bundleSize / BYTES_PER_KILOBYTE).toFixed(1)} kB)`);

if (values["dry-run"]) {
  await writeFile(payloadUrl, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`Dry run: wrote the payload to ${fileURLToPath(payloadUrl)}; nothing was sent.`);
  process.exit(0);
}

const apiKey = process.env.SMITHERY_API_KEY?.trim();
if (!apiKey) {
  console.error(`Set SMITHERY_API_KEY to a Smithery API key (${API_KEYS_URL}). It's read from the environment only, never from a file.`);
  process.exit(1);
}
const client = new Smithery({ apiKey });

try {
  await client.servers.create(qualifiedName);
  const release = await client.servers.releases.deploy(qualifiedName, { payload: JSON.stringify(payload), bundle: createReadStream(bundleUrl) });
  console.log(`Release ${release.deploymentId} accepted (${release.status}).`);
  for (const warning of release.warnings ?? []) console.warn(`  warning: ${warning}`);
  process.exitCode = await followRelease(release.deploymentId);
} catch (error) {
  console.error(`Publishing failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

/** Prints release logs until it finishes; returns the exit code. */
async function followRelease(deploymentId) {
  const releasesPage = `https://smithery.ai/servers/${qualifiedName}/releases`;
  const deadline = Date.now() + STATUS_TIMEOUT_MS;
  let printedLogCount = 0;
  while (Date.now() < deadline) {
    const release = await client.servers.releases.get(deploymentId, { qualifiedName });
    for (const log of (release.logs ?? []).slice(printedLogCount)) console.log(`  [${log.stage}] ${log.message}`);
    printedLogCount = release.logs?.length ?? printedLogCount;
    if (release.status === "SUCCESS") {
      console.log(`Published: https://smithery.ai/servers/${qualifiedName}`);
      return 0;
    }
    if (release.status === "AUTH_REQUIRED") {
      console.log(`Smithery needs authorization to finish; continue at ${releasesPage}`);
      return 0;
    }
    if (FAILED_STATUSES.has(release.status)) {
      console.error(`Release ${release.status}; see ${releasesPage}`);
      return 1;
    }
    await new Promise((resolve) => setTimeout(resolve, STATUS_POLL_INTERVAL_MS));
  }
  console.error(`Still running after ${STATUS_TIMEOUT_MS / MS_PER_MINUTE} minutes; follow it at ${releasesPage}`);
  return 1;
}
