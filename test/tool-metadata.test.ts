import { readFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REGISTRY_NAME, SERVER_TITLE, SHORT_DESCRIPTION, WEBSITE_URL } from "../src/metadata.js";
import { createDroplServer, SERVER_INSTRUCTIONS } from "../src/server.js";
import { PACKAGE_VERSION } from "../src/version.js";
import { makeTempDirectory, removeDirectory } from "./helpers/fixtures.js";

type Hints = Required<Pick<NonNullable<Tool["annotations"]>, "readOnlyHint" | "destructiveHint" | "idempotentHint" | "openWorldHint">>;

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const ADDS = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const OVERWRITES = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false } as const;
/** Feedback is written by clients (untrusted text) and replies or status changes email them. */
const CLIENT_FACING = { openWorldHint: true } as const;

/**
 * The audited hints for every tool. Read-only tools leave destructive/idempotent unset (the spec ignores them
 * when readOnlyHint is true), so they're compared as the spec's effective values.
 */
const EXPECTED_HINTS: Record<string, Hints> = {
  whoami: READ,
  list_sites: READ,
  list_showcases: READ,
  get_showcase: READ,
  list_showcase_items: READ,
  list_videos: READ,
  get_embed_code: READ,
  get_usage: READ,
  plan_migration: READ,
  list_projects: READ,
  create_project: ADDS,
  update_project: OVERWRITES,
  reorder_projects: OVERWRITES,
  reorder_project_items: OVERWRITES,
  get_project_details: READ,
  plan_project_details: READ,
  apply_project_details: OVERWRITES,
  list_collections: READ,
  get_collection_schema: READ,
  plan_collections: READ,
  list_collection_items: READ,
  get_collection_code: READ,
  list_feedback: { ...READ, ...CLIENT_FACING },
  get_feedback: { ...READ, ...CLIENT_FACING },
  create_site: ADDS,
  create_showcase: ADDS,
  create_category: ADDS,
  upload_videos: ADDS,
  add_videos_to_showcase: ADDS,
  add_collection_items: ADDS,
  reply_to_feedback: { ...ADDS, ...CLIENT_FACING },
  upload_photos: OVERWRITES,
  update_showcase: OVERWRITES,
  update_items: OVERWRITES,
  tag_items: OVERWRITES,
  apply_collection_plan: OVERWRITES,
  update_feedback_status: { ...OVERWRITES, ...CLIENT_FACING },
  undo_collection_change: { ...OVERWRITES, idempotentHint: false },
};

/** The spec's defaults when a hint is omitted. */
function effectiveHints(annotations: Tool["annotations"]): Hints {
  const readOnly = annotations?.readOnlyHint ?? false;
  return {
    readOnlyHint: readOnly,
    destructiveHint: readOnly ? false : (annotations?.destructiveHint ?? true),
    idempotentHint: readOnly ? true : (annotations?.idempotentHint ?? false),
    openWorldHint: annotations?.openWorldHint ?? true,
  };
}

type JsonSchema = { type?: string; description?: string; properties?: Record<string, JsonSchema>; items?: JsonSchema; anyOf?: JsonSchema[] };

/** Every object property below `schema`, with its path, looking through arrays and nullable unions. */
function nestedProperties(schema: JsonSchema, path: string): { path: string; schema: JsonSchema }[] {
  const found: { path: string; schema: JsonSchema }[] = [];
  for (const [name, property] of Object.entries(schema.properties ?? {})) {
    found.push({ path: `${path}.${name}`, schema: property });
    found.push(...nestedProperties(property, `${path}.${name}`));
  }
  if (schema.items) found.push(...nestedProperties(schema.items, `${path}[]`));
  for (const option of schema.anyOf ?? []) found.push(...nestedProperties(option, path));
  return found;
}

describe("tool metadata (what directories and the MCP Inspector show)", () => {
  let home: string;
  let client: Client;
  let tools: Tool[];

  beforeAll(async () => {
    home = await makeTempDirectory();
    const server = createDroplServer({ platform: { env: { XDG_CONFIG_HOME: home }, platform: process.platform, homeDirectory: home }, log: () => undefined });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: "metadata-test", version: "1.0.0" });
    await client.connect(clientTransport);
    tools = (await client.listTools()).tools;
  });
  afterAll(async () => {
    await client.close();
    await removeDirectory(home);
  });

  it("reports the package name, title, version, and website, plus instructions with the flow and the confirm rule", async () => {
    const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    expect(client.getServerVersion()).toMatchObject({
      name: packageJson.name,
      title: SERVER_TITLE,
      version: packageJson.version,
      description: SHORT_DESCRIPTION,
      websiteUrl: WEBSITE_URL,
    });
    expect(packageJson.version).toBe(PACKAGE_VERSION);
    const instructions = client.getInstructions() ?? "";
    expect(instructions).toBe(SERVER_INSTRUCTIONS);
    const overview = instructions.split("\n")[0]!;
    expect(overview.split(/(?<=\.)\s+/).length).toBeGreaterThanOrEqual(3);
    expect(overview.split(/(?<=\.)\s+/).length).toBeLessThanOrEqual(5);
    expect(overview).toMatch(/whoami, then list_sites \(or create_site\), create_showcase, upload_photos, and get_embed_code/);
    expect(overview).toContain("explicit confirmation");
    expect(REGISTRY_NAME).toBe(packageJson.mcpName);
  });

  it("covers exactly the audited tools", () => {
    expect(tools.map((tool) => tool.name).sort()).toEqual(Object.keys(EXPECTED_HINTS).sort());
  });

  it.each(Object.keys(EXPECTED_HINTS))("%s has a title, a what/when/constraint description, and accurate annotations", (name) => {
    const tool = tools.find((candidate) => candidate.name === name)!;
    expect(tool.title, "title").toMatch(/^[A-Z][\w ]+$/);
    expect(tool.annotations?.title).toBe(tool.title);
    for (const hint of ["readOnlyHint", "openWorldHint"] as const) expect(typeof tool.annotations?.[hint], hint).toBe("boolean");
    if (!tool.annotations?.readOnlyHint) {
      for (const hint of ["destructiveHint", "idempotentHint"] as const) expect(typeof tool.annotations?.[hint], hint).toBe("boolean");
    }
    expect(effectiveHints(tool.annotations)).toEqual(EXPECTED_HINTS[name]);

    const sentences = tool.description!.split(/(?<=[.!?])\s+(?=[A-Z])/);
    expect(sentences.length, "at least what, when, and a constraint").toBeGreaterThanOrEqual(3);
    expect(sentences[0], "starts with what it does").toMatch(/^[A-Z][\w-]*s\b|^Dry run: /);
    expect(tool.description, "says when to use it").toMatch(/\bUse (it|this)\b/);
  });

  it.each(Object.keys(EXPECTED_HINTS))("%s describes every parameter, with an example at the top level", (name) => {
    const schema = tools.find((candidate) => candidate.name === name)!.inputSchema as JsonSchema;
    for (const [property, definition] of Object.entries(schema.properties ?? {})) {
      expect(definition.description, `${name}.${property}`).toMatch(/\be\.g\. /);
    }
    for (const { path, schema: nested } of nestedProperties(schema, name)) {
      if (path.split(".").length > 2) expect(nested.description, path).toBeTruthy();
    }
  });
});
