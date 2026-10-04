import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { PROJECT_ERROR_CODES, type GalleryDetail } from "@dropl/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { completeOrder } from "../src/projects.js";
import { uploadPhotos } from "../src/photo-upload.js";
import { createDroplServer } from "../src/server.js";
import { makeTempDirectory, removeDirectory, uniqueJpeg, uploadContextFor, writeFiles } from "./helpers/fixtures.js";
import { MockDroplApi, TEST_API_KEY } from "./helpers/mock-api.js";

const PRESIGN_PATH = /^\/v1\/showcases\/[^/]+\/photos\/uploads$/;
const PROJECT_DETAILS_PATH = /^\/v1\/showcases\/[^/]+\/project-details$/;

interface TextResult {
  isError?: boolean;
  content: { type: string; text: string }[];
}

describe("projects showcases", () => {
  let api: MockDroplApi;
  let home: string;
  let configDirectory: string;
  let client: Client;

  beforeEach(async () => {
    api = new MockDroplApi();
    await api.start();
    home = await makeTempDirectory();
    configDirectory = await makeTempDirectory("dropl-mcp-config-");
    const server = createDroplServer({
      platform: { env: { XDG_CONFIG_HOME: configDirectory, DROPL_API_URL: api.baseUrl, DROPL_API_KEY: TEST_API_KEY }, platform: process.platform, homeDirectory: home },
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
    await removeDirectory(configDirectory);
  });

  async function call(name: string, args: Record<string, unknown> = {}): Promise<{ result: TextResult; data: any; text: string }> {
    const result = (await client.callTool({ name, arguments: args })) as TextResult;
    const text = result.content[0]!.text;
    let data: any = text;
    try {
      data = JSON.parse(text);
    } catch {
      // Error results are plain text.
    }
    return { result, data, text };
  }

  function projectsShowcase(overrides: Partial<GalleryDetail> = {}): GalleryDetail {
    return api.addShowcase("site1", { type: "projects", title: "Our homes", ...overrides });
  }

  it("creates a projects showcase and shows its type and project counts", async () => {
    const created = await call("create_showcase", { siteId: "site1", title: "Portfolio", type: "projects" });
    expect(created.result.isError).toBeFalsy();
    expect(api.requestsTo("POST", /^\/v1\/sites\/site1\/showcases$/)[0]!.body).toMatchObject({ type: "projects" });
    const showcaseId = created.data.showcase.id;

    await call("create_project", { showcaseId, title: "Arched Entry Two-Story" });
    const listed = await call("list_showcases", { siteId: "site1" });
    expect(listed.data.showcases.find((showcase: { id: string }) => showcase.id === showcaseId)).toMatchObject({ type: "projects", projectCount: 1 });
    const detail = await call("get_showcase", { showcaseId });
    expect(detail.data).toMatchObject({ type: "projects", projects: { count: 1 } });
  });

  it("creates, updates, lists and reorders projects", async () => {
    const showcase = projectsShowcase({
      projectDetailFields: [{ key: "location", label: "Location", type: "short_text", unit: null, options: null, showOnCard: true }],
    });

    const first = await call("create_project", {
      showcaseId: showcase.id,
      title: "Arched Entry Two-Story",
      subtitle: "Custom home",
      details: { location: "Austin, TX" },
      categories: ["Custom Homes"],
    });
    expect(first.result.isError).toBeFalsy();
    expect(first.data).toMatchObject({
      existed: false,
      createdCategories: ["Custom Homes"],
      project: { slug: "arched-entry-two-story", details: [{ key: "location", value: "Austin, TX" }], categories: ["Custom Homes"] },
    });
    const duplicate = await call("create_project", { showcaseId: showcase.id, title: "arched entry two-story" });
    expect(duplicate.data).toMatchObject({ existed: true, project: { id: first.data.project.id } });
    expect(api.requestsTo("POST", /\/projects$/)).toHaveLength(1);

    const badDetail = await call("create_project", { showcaseId: showcase.id, title: "Lake House", details: { year: 2024 } });
    expect(badDetail.result.isError).toBe(true);
    expect(badDetail.text).toContain("location");

    await call("create_project", { showcaseId: showcase.id, title: "Lake House" });
    const updated = await call("update_project", { showcaseId: showcase.id, project: "lake-house", description: "A cabin on the lake.", details: { location: "Lake Travis" } });
    expect(updated.data.project).toMatchObject({ description: "A cabin on the lake.", details: [{ key: "location", value: "Lake Travis" }] });
    const nothing = await call("update_project", { showcaseId: showcase.id, project: "lake-house" });
    expect(nothing.result.isError).toBe(true);
    const missing = await call("update_project", { showcaseId: showcase.id, project: "nowhere", title: "X" });
    expect(missing.result.isError).toBe(true);
    expect(missing.text).toContain("Lake House");

    const reordered = await call("reorder_projects", { showcaseId: showcase.id, projects: ["Lake House"] });
    expect(reordered.data.order.map((entry: { slug: string }) => entry.slug)).toEqual(["lake-house", "arched-entry-two-story"]);
    expect(api.requestsTo("PUT", /\/projects\/order$/)[0]!.body.projectIds).toHaveLength(2);

    const page = await call("list_projects", { showcaseId: showcase.id });
    expect(page.data).toMatchObject({ type: "projects", total: 2, nextOffset: null });
    expect(page.data.projects[0]).toMatchObject({ slug: "lake-house", excerpt: "A cabin on the lake.", details: { location: "Lake Travis" } });
    const one = await call("list_projects", { showcaseId: showcase.id, project: "lake-house" });
    expect(one.data).toMatchObject({ project: { slug: "lake-house", description: "A cabin on the lake." }, items: { total: 0 } });
  });

  it("refuses project tools on a gallery showcase", async () => {
    const gallery = api.addShowcase();
    const created = await call("create_project", { showcaseId: gallery.id, title: "Kitchen" });
    expect(created.result.isError).toBe(true);
    expect(api.requestsTo("POST", /\/projects$/)).toHaveLength(0);
  });

  it("plans project details without saving, then applies only with the version and confirmation for destructive changes", async () => {
    const showcase = projectsShowcase({
      projectDetailFields: [
        { key: "location", label: "Location", type: "short_text", unit: null, options: null, showOnCard: true },
        { key: "year", label: "Year", type: "year", unit: null, options: null, showOnCard: false },
      ],
    });
    api.addProject(showcase, { title: "Lake House", details: { location: "Lake Travis", year: 2023 } });

    const current = await call("get_project_details", { showcaseId: showcase.id });
    expect(current.data).toMatchObject({ version: 1, fields: [{ key: "location" }, { key: "year" }] });

    const withoutYear = [
      { key: "location", label: "City", type: "short_text", showOnCard: true },
      { label: "Size", type: "number", unit: "sq ft" },
    ];
    const plan = await call("plan_project_details", { showcaseId: showcase.id, fields: withoutYear, expectedVersion: 1 });
    expect(plan.result.isError).toBeFalsy();
    expect(plan.data).toMatchObject({ applied: false, destructive: true });
    expect(plan.data.summary).toContain("Year");
    expect(plan.data.nextStep).toContain("explicitly agree");
    expect(api.requestsTo("PUT", PROJECT_DETAILS_PATH).every((request) => request.body.dryRun === true && request.headers["idempotency-key"] === undefined)).toBe(true);
    expect(showcase.projectDetailsVersion).toBe(1);
    expect(showcase.projectDetailFields.map((field) => field.key)).toEqual(["location", "year"]);

    const unconfirmed = await call("apply_project_details", { showcaseId: showcase.id, fields: withoutYear, expectedVersion: 1 });
    expect(unconfirmed.result.isError).toBe(true);
    expect(unconfirmed.text).toContain(PROJECT_ERROR_CODES.confirmationRequired);
    expect(unconfirmed.text).toContain("explicitly agree");
    expect(showcase.projectDetailsVersion).toBe(1);

    const stale = await call("apply_project_details", { showcaseId: showcase.id, fields: withoutYear, expectedVersion: 0, confirmDestructive: true });
    expect(stale.result.isError).toBe(true);
    expect(stale.text).toContain("get_project_details");

    const applied = await call("apply_project_details", { showcaseId: showcase.id, fields: withoutYear, expectedVersion: 1, confirmDestructive: true });
    expect(applied.result.isError).toBeFalsy();
    expect(applied.data).toMatchObject({ applied: true, version: 2 });
    expect(showcase.projectDetailFields.map((field) => field.label)).toEqual(["City", "Size"]);
    expect(showcase.projects[0]!.details).toEqual({ location: "Lake Travis" });

    const renamedKey = await call("plan_project_details", { showcaseId: showcase.id, fields: [{ key: "city", label: "City", type: "short_text" }], expectedVersion: 2 });
    expect(renamedKey.result.isError).toBe(true);
    expect(renamedKey.text).toMatch(/Keys can't be changed/);
  });

  it("uploads photos into a project, keyed per project in the manifest", async () => {
    const showcase = projectsShowcase();
    const lake = api.addProject(showcase, { title: "Lake House" });
    const barn = api.addProject(showcase, { title: "Barn Conversion" });
    await writeFiles(home, { "lake/a.jpg": uniqueJpeg(1), "lake/b.jpg": uniqueJpeg(2) });
    const context = () => uploadContextFor(api, path.join(configDirectory, "dropl"));

    const dryRun = await uploadPhotos({ showcaseId: showcase.id, project: "Lake House", paths: ["lake"], cwd: home, dryRun: true }, context());
    expect(dryRun.project).toEqual({ id: lake.id, slug: "lake-house", title: "Lake House" });
    expect(dryRun.nextSteps.join(" ")).toContain("Lake House");
    expect(api.requestsTo("POST", PRESIGN_PATH)).toHaveLength(0);

    const first = await uploadPhotos({ showcaseId: showcase.id, project: "lake-house", paths: ["lake"], cwd: home }, context());
    expect(first).toMatchObject({ uploaded: 2, alreadyUploaded: 0 });
    expect(api.requestsTo("POST", PRESIGN_PATH).every((request) => request.body.projectId === lake.id)).toBe(true);
    expect(showcase.images.filter((item) => item.projectId === lake.id)).toHaveLength(2);

    const rerun = await uploadPhotos({ showcaseId: showcase.id, project: "lake-house", paths: ["lake"], cwd: home }, context());
    expect(rerun).toMatchObject({ uploaded: 0, alreadyUploaded: 2 });

    const otherProject = await uploadPhotos({ showcaseId: showcase.id, project: barn.id, paths: ["lake"], cwd: home }, context());
    expect(otherProject).toMatchObject({ uploaded: 2, alreadyUploaded: 0 });
    expect(api.requestsTo("POST", PRESIGN_PATH).at(-1)!.body.projectId).toBe(barn.id);
    expect(api.storagePuts).toHaveLength(4);

    const listed = await call("list_projects", { showcaseId: showcase.id, project: "lake-house" });
    expect(listed.data.items.total).toBe(2);
    expect(listed.data.items.items[0].localPath).toBe(path.join(home, "lake", "a.jpg"));

    const showcaseItems = await call("list_showcase_items", { showcaseId: showcase.id });
    expect(new Set(showcaseItems.data.items.map((item: { project: string }) => item.project))).toEqual(new Set(["lake-house", "barn-conversion"]));
  });

  it("requires a project in a projects showcase and rejects categories there", async () => {
    const showcase = projectsShowcase();
    api.addProject(showcase, { title: "Lake House" });
    await writeFiles(home, { "lake/a.jpg": uniqueJpeg(1) });

    const missingProject = await call("upload_photos", { showcaseId: showcase.id, paths: ["lake"], cwd: home });
    expect(missingProject.result.isError).toBe(true);
    expect(missingProject.text).toContain("Lake House");
    const withCategories = await call("upload_photos", { showcaseId: showcase.id, project: "lake-house", paths: ["lake"], cwd: home, categories: ["Decks"] });
    expect(withCategories.result.isError).toBe(true);
    expect(withCategories.text).toContain("categories belong to projects");

    const gallery = api.addShowcase();
    const projectInGallery = await call("upload_photos", { showcaseId: gallery.id, project: "lake-house", paths: ["lake"], cwd: home });
    expect(projectInGallery.result.isError).toBe(true);
    expect(api.requestsTo("POST", PRESIGN_PATH)).toHaveLength(0);
  });

  it("adds library videos to a project", async () => {
    const showcase = projectsShowcase();
    const lake = api.addProject(showcase, { title: "Lake House" });
    api.videos.set("vid1", { id: "vid1", publicId: "pub-vid1", title: "Walkthrough", deletedAt: null });

    const added = await call("add_videos_to_showcase", { showcaseId: showcase.id, videoIds: ["vid1"], project: "Lake House" });
    expect(added.result.isError).toBeFalsy();
    expect(api.requestsTo("POST", /\/videos$/).at(-1)!.body.projectId).toBe(lake.id);
    expect(showcase.images.find((item) => item.video?.id === "vid1")?.projectId).toBe(lake.id);

    const reordered = await call("reorder_project_items", { showcaseId: showcase.id, project: "lake-house", itemIds: ["vid1"] });
    expect(reordered.result.isError).toBeFalsy();
    expect(reordered.data.items).toHaveLength(1);
  });

  it("returns index and per-project embed snippets with a projectUrl", async () => {
    const showcase = projectsShowcase();
    api.addProject(showcase, { title: "Lake House" });
    api.addProject(showcase, { title: "Barn Conversion" });

    const index = await call("get_embed_code", { showcaseId: showcase.id, projectUrl: "/work/{slug}" });
    expect(index.result.isError).toBeFalsy();
    expect(api.requestsTo("GET", /\/embed$/).at(-1)!.query.get("projectUrl")).toBe("/work/{slug}");
    expect(index.data).toMatchObject({ type: "projects", project: null, projectUrl: "/work/{slug}" });
    expect(index.data.html).toContain('data-project-url="/work/{slug}"');
    expect(index.data.projectSnippets.map((entry: { slug: string }) => entry.slug)).toEqual(["lake-house", "barn-conversion"]);
    expect(index.data.notes.join(" ")).toContain("/work/[slug]");

    const page = await call("get_embed_code", { showcaseId: showcase.id, project: "Barn Conversion" });
    expect(page.data).toMatchObject({ project: { slug: "barn-conversion" } });
    expect(page.data.html).toContain('data-project="barn-conversion"');

    const badTemplate = await call("get_embed_code", { showcaseId: showcase.id, projectUrl: "/work/" });
    expect(badTemplate.result.isError).toBe(true);
    const onGallery = await call("get_embed_code", { showcaseId: api.addShowcase().id, project: "lake-house" });
    expect(onGallery.result.isError).toBe(true);
  });
});

describe("completeOrder", () => {
  it("puts the requested ids first and keeps the rest in order", () => {
    expect(completeOrder(["a", "b", "c", "d"], ["c", "a"], "project")).toEqual(["c", "a", "b", "d"]);
    expect(() => completeOrder(["a", "b"], ["a", "a"], "project")).toThrow(/listed twice/);
  });
});
