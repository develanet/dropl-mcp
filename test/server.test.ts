import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDroplServer, normalizeSiteDomain } from "../src/server.js";
import { makeTempDirectory, removeDirectory, uniqueJpeg, writeFiles } from "./helpers/fixtures.js";
import { MockDroplApi, TEST_API_KEY } from "./helpers/mock-api.js";

const EXPECTED_TOOLS = [
  "whoami",
  "list_sites",
  "create_site",
  "list_showcases",
  "create_showcase",
  "get_showcase",
  "update_showcase",
  "create_category",
  "tag_items",
  "upload_photos",
  "list_videos",
  "upload_videos",
  "add_videos_to_showcase",
  "get_embed_code",
  "get_usage",
  "plan_migration",
];

interface TextResult {
  isError?: boolean;
  content: { type: string; text: string }[];
}

describe("MCP server", () => {
  let api: MockDroplApi;
  let home: string;
  let logs: string[];

  beforeEach(async () => {
    api = new MockDroplApi();
    await api.start();
    home = await makeTempDirectory();
    logs = [];
  });
  afterEach(async () => {
    await api.stop();
    await removeDirectory(home);
  });

  async function connect(env: NodeJS.ProcessEnv): Promise<Client> {
    const server = createDroplServer({
      platform: { env: { XDG_CONFIG_HOME: home, DROPL_API_URL: api.baseUrl, ...env }, platform: process.platform, homeDirectory: home },
      log: (message) => logs.push(message),
      sleep: async () => undefined,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(clientTransport);
    return client;
  }

  async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<{ result: TextResult; data: any }> {
    const result = (await client.callTool({ name, arguments: args })) as TextResult;
    const text = result.content[0]!.text;
    let data: any = text;
    try {
      data = JSON.parse(text);
    } catch {
      // Error results are plain text.
    }
    return { result, data };
  }

  it("registers every tool with descriptions, and tells the agent to confirm before acting", async () => {
    const client = await connect({});
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([...EXPECTED_TOOLS].sort());
    for (const tool of tools) expect(tool.description?.length).toBeGreaterThan(20);
    for (const name of ["create_site", "create_showcase", "upload_photos", "upload_videos"]) {
      expect(tools.find((tool) => tool.name === name)!.description).toMatch(/confirmation/);
    }
    expect(tools.find((tool) => tool.name === "get_embed_code")!.description).toMatch(/instead of writing embed HTML by hand/);
    expect(tools.find((tool) => tool.name === "plan_migration")!.description).toMatch(/show the plan to the user/);

    const instructions = client.getInstructions() ?? "";
    expect(instructions).toContain("plan_migration");
    expect(instructions).toContain("explicit confirmation");
    expect(instructions).toContain("Never ask the user to paste an API key");
    expect(instructions).toContain("get_embed_code");
    expect(instructions).toContain("build");
  });

  it("tells the agent how to sign in when there are no credentials", async () => {
    const client = await connect({});
    const { result } = await call(client, "whoami");
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("npx -y @dropl/mcp login");
    expect(api.requests).toHaveLength(0);
  });

  it("runs the main flow against the API", async () => {
    const client = await connect({ DROPL_API_KEY: TEST_API_KEY });

    const whoami = await call(client, "whoami");
    expect(whoami.data).toMatchObject({ account: { name: "Acme Studio" }, role: "OWNER", apiKey: { sites: "all client sites" } });
    expect(JSON.stringify(whoami.data)).not.toContain(TEST_API_KEY);

    const site = await call(client, "create_site", { name: "Bayside Builders", domain: "https://www.Bayside.com/" });
    expect(site.data).toMatchObject({ site: { name: "Bayside Builders", domains: ["www.bayside.com"] }, alreadyCreated: false });
    const again = await call(client, "create_site", { name: "Bayside Builders", domain: "www.bayside.com" });
    expect(again.data).toMatchObject({ site: { id: site.data.site.id }, alreadyCreated: true });

    const showcase = await call(client, "create_showcase", { siteId: site.data.site.id, title: "Our work", showCategoryFilters: true });
    const showcaseId = showcase.data.showcase.id;
    expect(showcase.data.showcase).toMatchObject({ title: "Our work", itemCount: 0 });

    const category = await call(client, "create_category", { showcaseId, name: "Decks" });
    expect(category.data).toMatchObject({ category: { name: "Decks", slug: "decks" }, existed: false });
    const sameCategory = await call(client, "create_category", { showcaseId, name: "decks" });
    expect(sameCategory.data).toMatchObject({ category: { id: category.data.category.id }, existed: true });

    await writeFiles(home, { "media/Decks/a.jpg": uniqueJpeg(1), "media/b.jpg": uniqueJpeg(2) });
    const progress: number[] = [];
    const upload = (await client.callTool(
      { name: "upload_photos", arguments: { showcaseId, paths: ["media"], cwd: home, categoryFromFolder: true } },
      undefined,
      { onprogress: (notification) => progress.push(notification.progress) },
    )) as TextResult;
    expect(upload.isError).toBeFalsy();
    expect(JSON.parse(upload.content[0]!.text)).toMatchObject({ uploaded: 2, categories: [{ name: "Decks", created: false, tagged: 1 }] });
    expect(progress.at(-1)).toBe(2);

    const detail = await call(client, "get_showcase", { showcaseId });
    expect(detail.data).toMatchObject({ itemCount: 2, photos: 2, byStatus: { processing: 2 }, uncategorized: 1 });

    const embed = await call(client, "get_embed_code", { showcaseId, category: "Decks" });
    expect(embed.data).toMatchObject({ kind: "showcase", category: { slug: "decks" }, scriptSrc: `${api.origin}/embed/showcase.js` });
    expect(embed.data.html).toContain('data-category="decks"');
    expect(embed.data.container).toMatch(/^<div data-dropl-showcase=/);
    expect(embed.data.whereToPaste.join(" ")).toContain("next/script");

    const usage = await call(client, "get_usage");
    expect(usage.data.storage).toEqual({ used: "1 MB", limit: "10 MB", percent: 10, remaining: "9 MB" });

    const plan = await call(client, "plan_migration", { path: "media", cwd: home });
    expect(plan.data).toMatchObject({ totals: { photos: 2 }, storage: { remaining: "9 MB", fits: true } });
  });

  it("validates arguments before calling the API", async () => {
    const client = await connect({ DROPL_API_KEY: TEST_API_KEY });
    const both = await call(client, "get_embed_code", { videoId: "v1", showcaseId: "s1" });
    expect(both.result.isError).toBe(true);
    const badDomain = await call(client, "create_site", { name: "Acme", domain: "not a domain" });
    expect(badDomain.result.isError).toBe(true);
    expect(api.requestsTo("POST", /^\/v1\/sites$/)).toHaveLength(0);
  });
});

describe("normalizeSiteDomain", () => {
  it("accepts hostnames and pasted URLs", () => {
    expect(normalizeSiteDomain("Example.com")).toBe("example.com");
    expect(normalizeSiteDomain("https://shop.example.co.uk/about")).toBe("shop.example.co.uk");
    expect(() => normalizeSiteDomain("localhost")).toThrow();
  });
});
