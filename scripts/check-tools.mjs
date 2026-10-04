#!/usr/bin/env node
/*
 * What the MCP Inspector would show, without its web UI: starts the built server (dist/cli.js) over stdio
 * with the SDK client, prints serverInfo and instructions, and fails if a tool lacks a title, annotations,
 * a what/when description, or parameter descriptions. Run `pnpm build` first.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [cliPath],
  // No key: listing tools and reading serverInfo never need one.
  env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", DROPL_API_KEY: "" },
  stderr: "ignore",
});
const client = new Client({ name: "dropl-mcp-check", version: packageJson.version });
await client.connect(transport);

const problems = [];
const serverInfo = client.getServerVersion();
if (serverInfo?.name !== packageJson.name) problems.push(`serverInfo.name is ${serverInfo?.name}, expected ${packageJson.name}`);
if (serverInfo?.version !== packageJson.version) problems.push(`serverInfo.version is ${serverInfo?.version}, expected ${packageJson.version}`);
if (!client.getInstructions()) problems.push("no server instructions");

const { tools } = await client.listTools();
const rows = [];
for (const tool of tools) {
  const hints = tool.annotations ?? {};
  if (!tool.title) problems.push(`${tool.name}: no title`);
  if (typeof hints.readOnlyHint !== "boolean" || typeof hints.openWorldHint !== "boolean") problems.push(`${tool.name}: missing annotations`);
  if (!/\bUse (it|this)\b/.test(tool.description ?? "")) problems.push(`${tool.name}: description doesn't say when to use it`);
  for (const [name, property] of Object.entries(tool.inputSchema.properties ?? {})) {
    if (!/\be\.g\. /.test(property.description ?? "")) problems.push(`${tool.name}.${name}: no description with an example`);
  }
  const flag = (value) => (value === undefined ? "-" : String(value));
  rows.push(`| ${tool.name} | ${tool.title} | ${flag(hints.readOnlyHint)} | ${flag(hints.destructiveHint)} | ${flag(hints.idempotentHint)} | ${flag(hints.openWorldHint)} |`);
}
await client.close();

console.log(`Node ${process.version}`);
console.log(`serverInfo: ${JSON.stringify(serverInfo)}`);
console.log(`instructions: ${client.getInstructions()?.split("\n")[0]}`);
console.log(`\n| Tool | Title | readOnly | destructive | idempotent | openWorld |\n| --- | --- | --- | --- | --- | --- |\n${rows.join("\n")}`);
if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s):\n- ${problems.join("\n- ")}`);
  process.exit(1);
}
console.log(`\n${tools.length} tools OK.`);
