import { access, readFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { API_KEY_ENV } from "../src/config.js";
import { LONG_DESCRIPTION, SHORT_DESCRIPTION, WEBSITE_URL } from "../src/metadata.js";
import { createDroplServer } from "../src/server.js";
import { PACKAGE_NAME } from "../src/version.js";
import { buildSmitheryPayload, type ServerCard } from "../scripts/smithery-payload.mjs";
import { makeTempDirectory, removeDirectory } from "./helpers/fixtures.js";

const MIRROR_REPOSITORY_URL = "https://github.com/develanet/dropl-mcp";
const BUNDLE_OUTPUT_DIRECTORY = "build";
const readJson = async (relativePath: string) => JSON.parse(await readFile(new URL(relativePath, import.meta.url), "utf8"));

/** What bundle-mcpb.mjs reads from the staged server over stdio, read here in memory from the same source. */
async function inMemoryServerCard(): Promise<ServerCard> {
  const home = await makeTempDirectory();
  try {
    const server = createDroplServer({ platform: { env: { XDG_CONFIG_HOME: home }, platform: process.platform, homeDirectory: home }, log: () => undefined });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "mcpb-manifest-test", version: "1.0.0" });
    await client.connect(clientTransport);
    const { tools } = await client.listTools();
    const serverInfo = client.getServerVersion();
    await client.close();
    return { serverInfo, tools };
  } finally {
    await removeDirectory(home);
  }
}

async function registeredToolNames(): Promise<string[]> {
  return (await inMemoryServerCard()).tools.map((tool) => tool.name);
}

describe("MCPB bundle manifest (Claude Desktop and Smithery)", () => {
  it("matches package.json and the canonical listing copy", async () => {
    const packageJson = await readJson("../package.json");
    const manifest = await readJson("../manifest.json");

    expect(manifest).toMatchObject({
      manifest_version: "0.3",
      name: "dropl",
      display_name: "Dropl",
      version: packageJson.version,
      description: SHORT_DESCRIPTION,
      long_description: LONG_DESCRIPTION,
      author: { name: "Dropl", url: "https://www.dropl.io" },
      repository: { type: "git", url: MIRROR_REPOSITORY_URL },
      homepage: WEBSITE_URL,
      support: packageJson.bugs.url,
      license: packageJson.license,
    });
    expect(packageJson.homepage).toBe(manifest.homepage);
    expect(packageJson.repository.url).toBe(`git+${manifest.repository.url}.git`);
    expect(manifest.compatibility.runtimes).toEqual({ node: packageJson.engines.node });
    await expect(access(new URL(`../${manifest.icon}`, import.meta.url))).resolves.toBeUndefined();
  });

  it("runs the bundled entry point and maps the optional, secret API key to DROPL_API_KEY", async () => {
    const manifest = await readJson("../manifest.json");
    expect(manifest.server).toEqual({
      type: "node",
      entry_point: "server/index.js",
      mcp_config: { command: "node", args: ["${__dirname}/server/index.js"], env: { [API_KEY_ENV]: "${user_config.api_key}" } },
    });
    expect(Object.keys(manifest.user_config)).toEqual(["api_key"]);
    // Not required: users who ran `npx -y @dropl/mcp login` leave it blank and keep their saved sign-in.
    expect(manifest.user_config.api_key).toMatchObject({ type: "string", sensitive: true, required: false, default: "" });
  });

  it("lists exactly the tools the server registers", async () => {
    const manifest = await readJson("../manifest.json");
    const manifestToolNames = (manifest.tools as { name: string; description: string }[]).map((tool) => tool.name);
    expect(manifestToolNames.sort()).toEqual((await registeredToolNames()).sort());
    expect(manifest.tools_generated).toBe(false);
    for (const tool of manifest.tools) expect(tool.description, tool.name).toMatch(/^[A-Z].+\.$/);
  });

  it("keeps the bundle out of the npm tarball", async () => {
    const packageJson = await readJson("../package.json");
    expect(packageJson.files).not.toContain(BUNDLE_OUTPUT_DIRECTORY);
    expect(packageJson.files).not.toContain("manifest.json");
  });
});

describe("Smithery release payload", () => {
  it("sends the server's full tools (with inputSchema) and the API key setting as configSchema", async () => {
    const manifest = await readJson("../manifest.json");
    const serverCard = await inMemoryServerCard();
    const payload = buildSmitheryPayload(manifest, serverCard);

    expect(payload).toMatchObject({ type: "stdio", runtime: "node", serverCard: { serverInfo: { name: PACKAGE_NAME, version: manifest.version } } });
    expect(payload.serverCard.tools).toHaveLength(manifest.tools.length);
    for (const tool of payload.serverCard.tools) expect(tool.inputSchema.type, tool.name).toBe("object");
    expect(payload.configSchema).toEqual({
      type: "object",
      properties: { api_key: { type: "string", title: manifest.user_config.api_key.title, description: manifest.user_config.api_key.description, default: "" } },
      required: [],
    });
  });

  it("rejects the card `smithery mcp publish` builds from manifest.json (tools without inputSchema)", async () => {
    const manifest = await readJson("../manifest.json");
    const { serverInfo } = await inMemoryServerCard();
    expect(() => buildSmitheryPayload(manifest, { serverInfo, tools: manifest.tools })).toThrow(/isn't a valid MCP tool/);
  });

  it("rejects a card that drifted from manifest.json's tools or version", async () => {
    const manifest = await readJson("../manifest.json");
    const serverCard = await inMemoryServerCard();
    expect(() => buildSmitheryPayload(manifest, { ...serverCard, tools: serverCard.tools.slice(1) })).toThrow(/manifest\.json lists/);
    expect(() => buildSmitheryPayload({ ...manifest, version: "0.0.0" }, serverCard)).toThrow(/reports version/);
  });
});
