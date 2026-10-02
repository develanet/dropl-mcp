import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DroplApiClient } from "../src/api-client.js";
import { describeError, DroplApiError } from "../src/errors.js";
import { deriveIdempotencyKey, stableStringify } from "../src/idempotency.js";
import { parseRetryAfterMs, retryDelayMs } from "../src/retry.js";
import { MockDroplApi, TEST_API_KEY } from "./helpers/mock-api.js";

describe("DroplApiClient", () => {
  let api: MockDroplApi;
  let sleeps: number[];
  let client: DroplApiClient;

  beforeEach(async () => {
    api = new MockDroplApi();
    await api.start();
    sleeps = [];
    client = new DroplApiClient({
      apiUrl: api.baseUrl,
      apiKey: TEST_API_KEY,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
      },
      random: () => 0.5,
    });
  });
  afterEach(() => api.stop());

  it("sends the bearer key, user agent and idempotency key", async () => {
    await client.post("/v1/sites", { name: "Acme" }, { idempotencyKey: "dropl-mcp-abc" });
    const [request] = api.requestsTo("POST", /^\/v1\/sites$/);
    expect(request!.headers.authorization).toBe(`Bearer ${TEST_API_KEY}`);
    expect(request!.headers["idempotency-key"]).toBe("dropl-mcp-abc");
    expect(request!.headers["user-agent"]).toMatch(/^dropl-mcp\//);
  });

  it("retries 5xx with backoff, then succeeds", async () => {
    api.fail("GET", /^\/v1\/me$/, 503, 2);
    const me = await client.get<{ organization: { name: string } }>("/v1/me");
    expect(me.organization.name).toBe("Acme Studio");
    expect(api.requestsTo("GET", /^\/v1\/me$/)).toHaveLength(3);
    expect(sleeps).toEqual([1000, 2000]);
  });

  it("respects Retry-After on 429", async () => {
    api.fail("GET", /^\/v1\/me$/, 429, 1, { error: { code: "RATE_LIMITED", message: "Slow down." } }, { "retry-after": "3" });
    await client.get("/v1/me");
    expect(sleeps).toEqual([3000]);
  });

  it("retries IDEMPOTENCY_KEY_IN_PROGRESS", async () => {
    api.fail("POST", /^\/v1\/sites$/, 409, 1, { error: { code: "IDEMPOTENCY_KEY_IN_PROGRESS", message: "Still running." } });
    await client.post("/v1/sites", { name: "Acme" }, { idempotencyKey: "dropl-mcp-1" });
    expect(api.requestsTo("POST", /^\/v1\/sites$/)).toHaveLength(2);
  });

  it("doesn't retry client errors and surfaces the API message verbatim with its code", async () => {
    api.fail("POST", /^\/v1\/sites$/, 403, 1, { error: { code: "SITE_LIMIT_REACHED", message: "Your plan includes 5 client sites." } });
    const error = await client.post("/v1/sites", { name: "Acme" }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DroplApiError);
    expect(describeError(error)).toBe("Your plan includes 5 client sites. (SITE_LIMIT_REACHED, HTTP 403)");
    expect(api.requestsTo("POST", /^\/v1\/sites$/)).toHaveLength(1);
  });

  it("adds sign-in guidance to INVALID_API_KEY", async () => {
    const anonymous = new DroplApiClient({ apiUrl: api.baseUrl, apiKey: `dropl_test_${"z".repeat(43)}` });
    const error = await anonymous.get("/v1/me").catch((caught: unknown) => caught);
    expect(describeError(error)).toContain("npx -y @dropl/mcp login");
  });

  it("gives up after the attempt limit on persistent network errors", async () => {
    const offline = new DroplApiClient({
      apiUrl: "http://127.0.0.1:1/api",
      apiKey: TEST_API_KEY,
      maxAttempts: 2,
      sleep: async () => undefined,
    });
    await expect(offline.get("/v1/me")).rejects.toMatchObject({ status: 0, code: "NETWORK_ERROR" });
  });

  it("refuses to follow redirects", async () => {
    const redirecting = new DroplApiClient({
      apiUrl: api.baseUrl,
      apiKey: TEST_API_KEY,
      fetch: async () => new Response(null, { status: 302, headers: { location: "https://evil.example/api" } }),
    });
    await expect(redirecting.get("/v1/me")).rejects.toMatchObject({ code: "UNEXPECTED_REDIRECT" });
  });

  it("marks idempotent replays", async () => {
    const first = await client.request("POST", "/v1/sites", { body: { name: "Acme" }, idempotencyKey: "dropl-mcp-same" });
    const second = await client.request("POST", "/v1/sites", { body: { name: "Acme" }, idempotencyKey: "dropl-mcp-same" });
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.data).toEqual(first.data);
  });
});

describe("idempotency keys", () => {
  it("are stable regardless of object key order and differ by input", () => {
    expect(stableStringify({ b: 1, a: [2, { d: 3, c: 4 }] })).toBe('{"a":[2,{"c":4,"d":3}],"b":1}');
    const key = deriveIdempotencyKey("sites.create", { name: "Acme", domain: "acme.com" });
    expect(key).toBe(deriveIdempotencyKey("sites.create", { domain: "acme.com", name: "Acme" }));
    expect(key).not.toBe(deriveIdempotencyKey("sites.create", { name: "Acme 2", domain: "acme.com" }));
    expect(key).toMatch(/^dropl-mcp-[0-9a-f]{64}$/);
  });
});

describe("retry helpers", () => {
  it("backs off exponentially with a cap", () => {
    expect([1, 2, 3, 10].map((retry) => retryDelayMs(retry, () => 0.5))).toEqual([1000, 2000, 4000, 30000]);
  });

  it("parses Retry-After seconds and dates", () => {
    expect(parseRetryAfterMs("5")).toBe(5000);
    expect(parseRetryAfterMs(new Date(10_000).toUTCString(), 4_000)).toBe(6000);
    expect(parseRetryAfterMs("soon")).toBeNull();
    expect(parseRetryAfterMs(null)).toBeNull();
  });
});
