import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { COLLECTION_BULK_MAX_ITEMS } from "@dropl/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { itemFilterQuery, pickUndoableActivity } from "../src/collections.js";
import { createDroplServer, SERVER_INSTRUCTIONS } from "../src/server.js";
import { makeTempDirectory, removeDirectory } from "./helpers/fixtures.js";
import { MOCK_COLLECTION_ID, MockDroplApi, TEST_API_KEY } from "./helpers/mock-api.js";

interface TextResult {
  isError?: boolean;
  content: { type: string; text: string }[];
}

const MENU_FIELDS = [
  { key: "name", label: "Dish", type: "short_text", required: true },
  { key: "price", label: "Price", type: "price", currency: "USD" },
];

describe("collection tools", () => {
  let api: MockDroplApi;
  let home: string;
  let client: Client;

  beforeEach(async () => {
    api = new MockDroplApi();
    await api.start();
    home = await makeTempDirectory();
    const server = createDroplServer({
      platform: { env: { XDG_CONFIG_HOME: home, DROPL_API_URL: api.baseUrl, DROPL_API_KEY: TEST_API_KEY }, platform: process.platform, homeDirectory: home },
      log: () => undefined,
      sleep: async () => undefined,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(clientTransport);
  });
  afterEach(async () => {
    await api.stop();
    await removeDirectory(home);
  });

  async function call(name: string, args: Record<string, unknown> = {}): Promise<{ result: TextResult; data: any }> {
    const result = (await client.callTool({ name, arguments: args })) as TextResult;
    const text = result.content[0]!.text;
    try {
      return { result, data: JSON.parse(text) };
    } catch {
      return { result, data: text };
    }
  }

  it("tells the agent to read the schema first, dry run, confirm, and keep manual edits", async () => {
    expect(SERVER_INSTRUCTIONS).toContain("get_collection_schema before changing a collection");
    expect(SERVER_INSTRUCTIONS).toContain("Never revert or overwrite their edits");
    expect(SERVER_INSTRUCTIONS).toContain("confirmDestructive: true only after");
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    for (const name of ["apply_collection_plan", "undo_collection_change"]) {
      expect(byName.get(name)!.description).toMatch(/confirmation/);
      expect(byName.get(name)!.annotations?.destructiveHint).toBe(true);
    }
    for (const name of ["list_collections", "get_collection_schema", "plan_collections", "list_collection_items", "get_collection_code"]) {
      expect(byName.get(name)!.annotations?.readOnlyHint).toBe(true);
    }
  });

  it("lists collections and reads the schema without the generated code", async () => {
    const list = await call("list_collections", { siteId: "site1" });
    expect(list.data.collections).toEqual([expect.objectContaining({ id: MOCK_COLLECTION_ID, slug: "menu" })]);
    expect(list.data.limits).toMatchObject({ itemLimit: 1000 });

    const schema = await call("get_collection_schema", { collectionId: MOCK_COLLECTION_ID });
    expect(schema.data).toMatchObject({ schemaVersion: 3, titleFieldKey: "name", timezone: "America/Chicago" });
    expect(schema.data.typescript).toBeUndefined();
  });

  it("plan_collections always dry runs; apply needs confirmation for destructive plans", async () => {
    const withoutPrice = [{ slug: "menu", name: "Menu", fields: [MENU_FIELDS[0]], expectedSchemaVersion: 3 }];
    const plan = await call("plan_collections", { siteId: "site1", collections: withoutPrice });
    expect(plan.data).toMatchObject({ applied: false, destructive: true });
    expect(plan.data.nextStep).toContain("confirmDestructive: true after they explicitly agree");
    expect(api.requestsTo("POST", /\/plan$/)[0]!.body.dryRun).toBe(true);

    const refused = await call("apply_collection_plan", { siteId: "site1", collections: withoutPrice });
    expect(refused.result.isError).toBe(true);
    expect(refused.data).toContain("CONFIRMATION_REQUIRED");
    expect(refused.data).toContain("explicitly agree");

    const applied = await call("apply_collection_plan", { siteId: "site1", collections: withoutPrice, confirmDestructive: true });
    expect(applied.data).toMatchObject({ applied: true });
    expect(api.requestsTo("POST", /\/plan$/).at(-1)!.body).toMatchObject({ dryRun: false, confirmDestructive: true });
  });

  it("rejects field keys websites couldn't use before calling the API", async () => {
    const result = await call("plan_collections", { siteId: "site1", collections: [{ name: "Menu", fields: [{ key: "Bad Key", label: "Bad", type: "short_text" }] }] });
    expect(result.result.isError).toBe(true);
    expect(api.requestsTo("POST", /\/plan$/)).toHaveLength(0);
  });

  it("dry runs items by default and reports per-item errors by position in the call", async () => {
    const items = [{ values: { name: "Soup" } }, { values: { price: { amount: 3 } } }];
    const dryRun = await call("add_collection_items", { collectionId: MOCK_COLLECTION_ID, items });
    expect(dryRun.data).toMatchObject({ dryRun: true, created: 0, valid: 1, failed: 1, errors: [{ index: 1, errors: { name: "Name is required." } }] });
    expect(api.collectionItems).toHaveLength(0);

    const saved = await call("add_collection_items", { collectionId: MOCK_COLLECTION_ID, items, dryRun: false });
    expect(saved.data).toMatchObject({ created: 1, failed: 1 });
    expect(api.collectionItems).toHaveLength(1);
    expect(api.requestsTo("POST", /\/items\/bulk$/).at(-1)!.headers["idempotency-key"]).toMatch(/^dropl-mcp-/);
  });

  it("splits large imports into API batches and offsets error indexes", async () => {
    const total = COLLECTION_BULK_MAX_ITEMS + 2;
    const items = Array.from({ length: total }, (_, index) => ({ values: index === total - 1 ? {} : { name: `Dish ${index}` } }));
    const result = await call("add_collection_items", { collectionId: MOCK_COLLECTION_ID, items, dryRun: false });
    expect(api.requestsTo("POST", /\/items\/bulk$/)).toHaveLength(2);
    expect(result.data).toMatchObject({ created: total - 1, failed: 1, errors: [{ index: total - 1 }] });
  });

  it("all_or_nothing across batches validates everything before saving anything", async () => {
    const total = COLLECTION_BULK_MAX_ITEMS + 1;
    const items = Array.from({ length: total }, (_, index) => ({ values: index === total - 1 ? {} : { name: `Dish ${index}` } }));
    const result = await call("add_collection_items", { collectionId: MOCK_COLLECTION_ID, items, dryRun: false, mode: "all_or_nothing" });
    expect(result.data).toMatchObject({ created: 0, valid: 0, failed: 1 });
    expect(api.collectionItems).toHaveLength(0);
    expect(api.requestsTo("POST", /\/items\/bulk$/).every((request) => request.body.dryRun === true)).toBe(true);
  });

  it("passes search, filters, and paging to the item list", async () => {
    await call("list_collection_items", {
      collectionId: MOCK_COLLECTION_ID,
      q: "soup",
      status: "published",
      filters: [{ field: "spice", value: "hot,mild" }, { field: "price", operator: "lte", value: "10" }],
      limit: 20,
      offset: 40,
    });
    const query = api.requestsTo("GET", /\/items$/)[0]!.query;
    expect(Object.fromEntries(query)).toEqual({ q: "soup", status: "published", limit: "20", offset: "40", "filter[spice]": "hot,mild", "filter[price][lte]": "10" });
  });

  it("returns generated types and a Next.js example for public collections", async () => {
    const code = await call("get_collection_code", { collectionId: MOCK_COLLECTION_ID });
    expect(code.data.typescript).toBe("export interface MenuItem {}");
    expect(code.data.nextJsExample).toContain(code.data.publicItemsUrl);
    expect(code.data.notes.join(" ")).toContain("drafts and trashed items never appear");
  });

  it("undoes the most recent undoable schema change and explains when there is none", async () => {
    const undone = await call("undo_collection_change", { collectionId: MOCK_COLLECTION_ID });
    expect(undone.data).toMatchObject({ undone: `Renamed "Cost" to "Price"`, schemaVersion: 4 });
    expect(api.requestsTo("POST", /\/activity\/act1\/undo$/)).toHaveLength(1);

    const again = await call("undo_collection_change", { collectionId: MOCK_COLLECTION_ID });
    expect(again.result.isError).toBe(true);
    expect(again.data).toContain("no recent schema change that can be undone");
  });
});

describe("collection helpers", () => {
  it("builds filter query parameters and refuses duplicates", () => {
    expect(itemFilterQuery([{ field: "spice", value: "hot" }, { field: "price", operator: "gte", value: "5" }])).toEqual({ "filter[spice]": "hot", "filter[price][gte]": "5" });
    expect(() => itemFilterQuery([{ field: "spice", value: "hot" }, { field: "spice", operator: "eq", value: "mild" }])).toThrow(/twice/);
  });

  it("refuses to undo an entry that is no longer undoable", () => {
    const activity = { activity: [{ id: "a1", action: "schema.changed", summary: "Removed field", actor: { type: "user", name: "Ada" }, createdAt: "", undoable: false, undoneAt: null }] } as never;
    expect(() => pickUndoableActivity(activity, "a1")).toThrow(/can't be undone anymore/);
    expect(() => pickUndoableActivity(activity, "missing")).toThrow(/No activity/);
  });
});
