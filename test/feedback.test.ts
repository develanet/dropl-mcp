import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { FEEDBACK_PLAN_REQUIRED_CODE, FEEDBACK_PLAN_REQUIRED_MESSAGE, PUBLIC_API_ERROR_CODES } from "@dropl/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LOGIN_COMMAND } from "../src/config.js";
import { describeError, DroplApiError } from "../src/errors.js";
import { createDroplServer, SERVER_INSTRUCTIONS } from "../src/server.js";
import { makeTempDirectory, removeDirectory } from "./helpers/fixtures.js";
import { MOCK_FEEDBACK_ID, MockDroplApi, TEST_API_KEY } from "./helpers/mock-api.js";

interface TextResult {
  isError?: boolean;
  content: { type: string; text: string }[];
}

const FEEDBACK_TOOLS = ["list_feedback", "get_feedback", "reply_to_feedback", "update_feedback_status"];

describe("feedback tools", () => {
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

  it("describes the fix-the-feedback workflow in the instructions and tool descriptions", async () => {
    expect(SERVER_INSTRUCTIONS).toContain("To fix the open Dropl feedback");
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    for (const name of FEEDBACK_TOOLS) expect(byName.has(name)).toBe(true);
    expect(byName.get("list_feedback")!.description).toContain("applied directly in the code");
    expect(byName.get("get_feedback")!.description).toContain("asking the client to clarify instead of guessing");
    expect(byName.get("update_feedback_status")!.description).toContain("short note");
    expect(byName.get("list_feedback")!.annotations?.readOnlyHint).toBe(true);
    expect(byName.get("get_feedback")!.annotations?.readOnlyHint).toBe(true);
    expect(byName.get("reply_to_feedback")!.annotations?.readOnlyHint).toBe(false);
  });

  it("lists open and in-progress requests by default and passes filters", async () => {
    const list = await call("list_feedback", { siteId: "site1" });
    expect(list.data.requests).toEqual([
      expect.objectContaining({ id: MOCK_FEEDBACK_ID, number: 7, type: "text_change", currentText: "Open 9-5", requestedText: "Open 8-6", requester: "Cleo Client", hasScreenshot: true }),
    ]);
    expect(list.data).toMatchObject({ total: 3, nextOffset: 1 });
    expect(Object.fromEntries(api.requestsTo("GET", /\/v1\/sites\/site1\/feedback$/)[0]!.query)).toEqual({ status: "open,in_progress" });

    await call("list_feedback", { siteId: "site1", status: ["done"], type: "comment", page: "/menu", limit: 10, offset: 20 });
    expect(Object.fromEntries(api.requestsTo("GET", /\/feedback$/).at(-1)!.query)).toEqual({ status: "done", type: "comment", page: "/menu", limit: "10", offset: "20" });
  });

  it("rejects unknown statuses before calling the API", async () => {
    const result = await call("list_feedback", { siteId: "site1", status: ["closed"] });
    expect(result.result.isError).toBe(true);
    expect(api.requestsTo("GET", /\/feedback$/)).toHaveLength(0);
  });

  it("returns the full context with the screenshot listed once", async () => {
    const detail = await call("get_feedback", { requestId: MOCK_FEEDBACK_ID });
    expect(detail.data).toMatchObject({
      pageUrl: "https://acme.example.com/contact",
      pagePath: "/contact",
      element: { selector: "main > p:nth-of-type(2)", tagName: "p", textHint: "Open 9-5" },
      context: { deviceType: "mobile", viewport: { width: 390, height: 844 } },
      allowedStatuses: ["open", "in_progress", "done", "wont_do"],
      thread: [],
    });
    expect(detail.data.attachments).toEqual([expect.objectContaining({ purpose: "screenshot", url: "https://cdn.example.com/att1-large.webp" })]);
  });

  it("explains a missing request", async () => {
    const missing = await call("get_feedback", { requestId: "nope" });
    expect(missing.result.isError).toBe(true);
    expect(missing.data).toContain("Feedback request not found.");
  });

  it("replies once per message, even when retried", async () => {
    const first = await call("reply_to_feedback", { requestId: MOCK_FEEDBACK_ID, message: "Which hours do you want on weekends?" });
    expect(first.data).toMatchObject({ replied: true, alreadySent: false });
    const again = await call("reply_to_feedback", { requestId: MOCK_FEEDBACK_ID, message: "Which hours do you want on weekends?" });
    expect(again.data).toMatchObject({ replied: true, alreadySent: true, messageId: first.data.messageId });
    expect(api.feedbackRequest.messages).toHaveLength(1);
    const replies = api.requestsTo("POST", /\/replies$/);
    expect(replies[0]!.body).toEqual({ message: "Which hours do you want on weekends?" });
    expect(replies[0]!.headers["idempotency-key"]).toMatch(/^dropl-mcp-/);
  });

  it("marks a request done with a note and reports that the client is emailed", async () => {
    const done = await call("update_feedback_status", { requestId: MOCK_FEEDBACK_ID, status: "done", resolutionNote: "Updated the hours." });
    expect(done.data).toEqual({ id: MOCK_FEEDBACK_ID, number: 7, status: "done", resolutionNote: "Updated the hours.", clientNotified: true });
    expect(api.requestsTo("PATCH", /\/v1\/feedback\/fb1$/)[0]!.body).toEqual({ status: "done", resolutionNote: "Updated the hours." });

    const progress = await call("update_feedback_status", { requestId: MOCK_FEEDBACK_ID, status: "in_progress" });
    expect(progress.data).toMatchObject({ status: "in_progress", resolutionNote: null, clientNotified: false });
  });

  it("turns a missing feedback scope into a sign-in-again hint", async () => {
    api.fail("GET", /\/feedback$/, 403, 1, { error: { code: PUBLIC_API_ERROR_CODES.insufficientScope, message: "This API key needs the feedback:read scope." } });
    const result = await call("list_feedback", { siteId: "site1" });
    expect(result.result.isError).toBe(true);
    expect(result.data).toContain(LOGIN_COMMAND);
    expect(result.data).toContain("Never ask them to paste a key");
  });

  it("explains PLAN_REQUIRED without suggesting a retry", async () => {
    api.fail("POST", /\/replies$/, 403, 1, { error: { code: FEEDBACK_PLAN_REQUIRED_CODE, message: FEEDBACK_PLAN_REQUIRED_MESSAGE } });
    const result = await call("reply_to_feedback", { requestId: MOCK_FEEDBACK_ID, message: "On it." });
    expect(result.result.isError).toBe(true);
    expect(result.data).toContain(FEEDBACK_PLAN_REQUIRED_MESSAGE);
    expect(result.data).toContain("upgrade under Billing");
  });
});

describe("feedback error hints", () => {
  it("keeps the generic scope hint for other scopes", () => {
    const text = describeError(new DroplApiError(403, PUBLIC_API_ERROR_CODES.insufficientScope, "This API key needs the collections:write scope."));
    expect(text).toContain("Settings → API keys");
    expect(text).not.toContain(LOGIN_COMMAND);
  });
});
