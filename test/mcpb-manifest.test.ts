import { access, readFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { API_KEY_ENV } from "../src/config.js";
import { LONG_DESCRIPTION, SHORT_DESCRIPTION, WEBSITE_URL } from "../src/metadata.js";
import { createDroplServer } from "../src/server.js";
import { makeTempDirectory, removeDirectory } from "./helpers/fixtures.js";

const MIRROR_REPOSITORY_URL = "https://github.com/develanet/dropl-mcp";
const BUNDLE_OUTPUT_DIRECTORY = "build";
const readJson = async (relativePath: string) => JSON.parse(await readFile(new URL(relativePath, import.meta.url), "utf8"));

async function registeredToolNames(): Promise<string[]> {
  const home = await makeTempDirectory();
  try {
    const server = createDroplServer({ platform: { env: { XDG_CONFIG_HOME: home }, platform: process.platform, homeDirectory: home }, log: () => undefined });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "mcpb-manifest-test", version: "1.0.0" });
    await client.connect(clientTransport);
    const { tools } = await client.listTools();
    await client.close();
    return tools.map((tool) => tool.name);
  } finally {
    await removeDirectory(home);
  }
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
