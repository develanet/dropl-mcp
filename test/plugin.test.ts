import { readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { SHORT_DESCRIPTION, WEBSITE_URL } from "../src/metadata.js";
import { createDroplServer } from "../src/server.js";
import { PACKAGE_NAME, PACKAGE_VERSION } from "../src/version.js";

/** Agent Plugins 1.0.0 (https://open-plugins.com): both documents must target the same spec version. */
const PLUGIN_SCHEMA_URL = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
const MCP_SCHEMA_URL = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";
const PLUGIN_MANIFEST_FIELDS = ["$schema", "name", "version", "description", "author", "homepage", "repository", "license", "keywords", "extensions"];
const PLUGIN_NAME_PATTERN = /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;
const STDIO_SERVER_FIELDS = ["type", "command", "args", "env", "cwd"];
/** Agent Skills (https://agentskills.io/specification) frontmatter rules. */
const SKILL_FRONTMATTER_FIELDS = ["name", "description", "license", "compatibility", "metadata", "allowed-tools"];
const SKILL_NAME_PATTERN = /^(?!.*--)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const SKILL_NAME_MAX_LENGTH = 64;
const SKILL_DESCRIPTION_MAX_LENGTH = 1024;
const MIN_SKILLS = 1;
const MIRROR_REPOSITORY_URL = "https://github.com/develanet/dropl-mcp";
const PLUGIN_FILES = ["plugin.json", "mcp.json", "skills"];
/** Backticked identifiers like `list_feedback`, `siteId`, or `wont_do`. */
const CODE_IDENTIFIER_PATTERN = /`([a-z][a-zA-Z0-9_]*)`/g;

const packageRoot = new URL("../", import.meta.url);
const readJson = async (relativePath: string) => JSON.parse(await readFile(new URL(relativePath, packageRoot), "utf8"));

async function readSkills() {
  const entries = await readdir(new URL("skills/", packageRoot), { withFileTypes: true });
  const skills = [];
  for (const entry of entries.filter((candidate) => candidate.isDirectory())) {
    const text = await readFile(new URL(`skills/${entry.name}/SKILL.md`, packageRoot), "utf8");
    const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
    expect(match, `skills/${entry.name}/SKILL.md needs YAML frontmatter`).not.toBeNull();
    const frontmatter: Record<string, string> = Object.fromEntries(
      match![1]!.split("\n").map((line) => {
        const separator = line.indexOf(":");
        return [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
      }),
    );
    skills.push({ directory: entry.name, frontmatter, body: match![2]! });
  }
  return skills;
}

/** Tool names, parameter names, and enum values the running server exposes. */
async function serverVocabulary() {
  const server = createDroplServer({ platform: { env: {}, platform: process.platform, homeDirectory: tmpdir() }, log: () => undefined });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "plugin-test", version: "1.0.0" });
  await client.connect(clientTransport);
  const { tools } = await client.listTools();
  await client.close();

  const terms = new Set<string>();
  const collect = (schema: unknown): void => {
    if (Array.isArray(schema)) return schema.forEach(collect);
    if (!schema || typeof schema !== "object") return;
    const node = schema as Record<string, unknown>;
    if (Array.isArray(node.enum)) for (const value of node.enum) if (typeof value === "string") terms.add(value);
    if (node.properties && typeof node.properties === "object") for (const name of Object.keys(node.properties)) terms.add(name);
    Object.values(node).forEach(collect);
  };
  for (const tool of tools) collect(tool.inputSchema);
  return { toolNames: new Set(tools.map((tool) => tool.name)), terms };
}

describe("Agent Plugin package", () => {
  it("has a valid plugin.json on the package version", async () => {
    const packageJson = await readJson("package.json");
    const manifest = await readJson("plugin.json");

    expect(PLUGIN_MANIFEST_FIELDS).toEqual(expect.arrayContaining(Object.keys(manifest)));
    expect(manifest.$schema).toBe(PLUGIN_SCHEMA_URL);
    expect(manifest.name).toBe("dropl");
    expect(manifest.name).toMatch(PLUGIN_NAME_PATTERN);
    expect(manifest.version).toBe(packageJson.version);
    expect(manifest.version).toBe(PACKAGE_VERSION);
    expect(manifest.description).toBe(SHORT_DESCRIPTION);
    expect(manifest.author).toEqual({ name: "Dropl", url: "https://www.dropl.io" });
    expect(manifest.homepage).toBe(WEBSITE_URL);
    expect(manifest.repository).toBe(MIRROR_REPOSITORY_URL);
    expect(manifest.license).toBe(packageJson.license);
    expect(manifest.keywords.length).toBeGreaterThan(0);
    for (const keyword of manifest.keywords) expect(typeof keyword).toBe("string");
  });

  it("launches the published @dropl/mcp server from mcp.json, without secrets", async () => {
    const config = await readJson("mcp.json");

    expect(Object.keys(config).sort()).toEqual(["$schema", "mcpServers"]);
    expect(config.$schema).toBe(MCP_SCHEMA_URL);
    expect(Object.keys(config.mcpServers)).toEqual(["dropl"]);
    const server = config.mcpServers.dropl;
    expect(STDIO_SERVER_FIELDS).toEqual(expect.arrayContaining(Object.keys(server)));
    expect(server).toEqual({ type: "stdio", command: "npx", args: ["-y", `${PACKAGE_NAME}@latest`] });
  });

  it("keeps the plugin files out of the npm tarball", async () => {
    const packageJson = await readJson("package.json");
    for (const file of PLUGIN_FILES) expect(packageJson.files).not.toContain(file);
  });

  it("ships skills that follow the Agent Skills format and only reference real tools", async () => {
    const skills = await readSkills();
    const { toolNames, terms } = await serverVocabulary();
    expect(skills.length).toBeGreaterThanOrEqual(MIN_SKILLS);

    for (const skill of skills) {
      const { name = "", description = "" } = skill.frontmatter;
      expect(SKILL_FRONTMATTER_FIELDS).toEqual(expect.arrayContaining(Object.keys(skill.frontmatter)));
      expect(name).toBe(skill.directory);
      expect(name).toMatch(SKILL_NAME_PATTERN);
      expect(name.length).toBeLessThanOrEqual(SKILL_NAME_MAX_LENGTH);
      expect(description.length).toBeGreaterThan(0);
      expect(description.length).toBeLessThanOrEqual(SKILL_DESCRIPTION_MAX_LENGTH);

      const identifiers = [...skill.body.matchAll(CODE_IDENTIFIER_PATTERN)].map((match) => match[1]!);
      const unknown = identifiers.filter((identifier) => !toolNames.has(identifier) && !terms.has(identifier));
      expect(unknown, `${skill.directory} references names the server doesn't have`).toEqual([]);
      expect(identifiers.some((identifier) => toolNames.has(identifier)), `${skill.directory} references no tools`).toBe(true);
    }
  });
});
