import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { partByteRange, uploadVideos, videoTitleFromFileName } from "../src/video-upload.js";
import { JPEG_BYTES, makeTempDirectory, mp4Bytes, removeDirectory, uploadContextFor, writeFiles } from "./helpers/fixtures.js";
import { MockDroplApi } from "./helpers/mock-api.js";

const PART_SIZE_BYTES = 1024;
const FILE_SIZE_BYTES = 2600;
const CREATE_PATH = /^\/v1\/sites\/[^/]+\/videos\/uploads$/;

describe("upload_videos", () => {
  let api: MockDroplApi;
  let root: string;
  let configDirectory: string;

  beforeEach(async () => {
    api = new MockDroplApi();
    api.partSizeBytes = PART_SIZE_BYTES;
    await api.start();
    root = await makeTempDirectory();
    configDirectory = await makeTempDirectory("dropl-mcp-config-");
  });
  afterEach(async () => {
    await api.stop();
    await removeDirectory(root);
    await removeDirectory(configDirectory);
  });

  it("splits a video into parts of exactly partSizeBytes (except the last) and completes it", async () => {
    await writeFiles(root, { "Site Tour.mp4": mp4Bytes(FILE_SIZE_BYTES) });

    const summary = await uploadVideos({ siteId: "site1", paths: [root] }, uploadContextFor(api, configDirectory));

    expect(summary.uploaded.count).toBe(1);
    expect(summary.uploaded.videos[0]).toMatchObject({ title: "Site Tour" });
    expect(api.storagePuts.map((put) => put.bytes).sort((a, b) => b - a)).toEqual([1024, 1024, 552]);
    expect(api.storagePuts.every((put) => put.authorization === undefined)).toBe(true);
    const [create] = api.requestsTo("POST", CREATE_PATH);
    expect(create!.body).toEqual({ fileName: "Site Tour.mp4", contentType: "video/mp4", sizeBytes: FILE_SIZE_BYTES, title: "Site Tour" });
    expect(create!.headers["idempotency-key"]).toMatch(/^dropl-mcp-/);
    const [complete] = api.requestsTo("POST", /\/complete$/);
    expect(complete!.headers["idempotency-key"]).toMatch(/^dropl-mcp-/);
    expect(api.requestsTo("POST", /\/parts$/)[0]!.body.partNumbers).toEqual([1, 2, 3]);
  });

  it("resumes an interrupted upload with only the missing parts", async () => {
    await writeFiles(root, { "clip.mov": mp4Bytes(FILE_SIZE_BYTES) });
    api.fail("PUT", /^\/storage\/part\/[^/]+\/2$/, 400, 1);

    const firstRun = await uploadVideos({ siteId: "site1", paths: [root] }, uploadContextFor(api, configDirectory));
    expect(firstRun.failed.count).toBe(1);
    expect(firstRun.failed.files[0]!.error).toContain("Part 2 failed");
    const putsAfterFirstRun = api.storagePuts.length;

    const secondRun = await uploadVideos({ siteId: "site1", paths: [root] }, uploadContextFor(api, configDirectory));

    expect(secondRun.uploaded.count).toBe(1);
    expect(api.storagePuts.slice(putsAfterFirstRun).map((put) => put.path)).toEqual([expect.stringMatching(/\/2$/)]);
    expect(api.requestsTo("POST", CREATE_PATH)).toHaveLength(1);
    expect(api.requestsTo("GET", /^\/v1\/uploads\/[^/]+$/)).toHaveLength(1);
    expect([...api.sessions.values()][0]!.status).toBe("completed");
  });

  it("skips videos that already finished on a re-run", async () => {
    await writeFiles(root, { "clip.webm": Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(100)]) });
    await uploadVideos({ siteId: "site1", paths: [root] }, uploadContextFor(api, configDirectory));
    const rerun = await uploadVideos({ siteId: "site1", paths: [root] }, uploadContextFor(api, configDirectory));
    expect(rerun.alreadyUploaded.count).toBe(1);
    expect(rerun.uploaded.count).toBe(0);
    expect(api.requestsTo("POST", CREATE_PATH)).toHaveLength(1);
  });

  it("retries part uploads on storage 5xx", async () => {
    await writeFiles(root, { "clip.mp4": mp4Bytes(FILE_SIZE_BYTES) });
    api.fail("PUT", /^\/storage\/part\//, 503, 2);
    const context = uploadContextFor(api, configDirectory);
    const summary = await uploadVideos({ siteId: "site1", paths: [root] }, context);
    expect(summary.uploaded.count).toBe(1);
    expect(context.sleeps.length).toBeGreaterThanOrEqual(2);
  });

  it("adds uploaded videos to a showcase and tags them by folder", async () => {
    await writeFiles(root, { "Reels/tour.mp4": mp4Bytes(FILE_SIZE_BYTES), "intro.m4v": mp4Bytes(500) });
    const showcase = api.addShowcase();

    const summary = await uploadVideos(
      { siteId: "site1", paths: [root], showcaseId: showcase.id, categoryFromFolder: true },
      uploadContextFor(api, configDirectory),
    );

    expect(summary.showcase).toMatchObject({ id: showcase.id, videosAdded: 2 });
    expect(summary.showcase!.categories).toEqual([expect.objectContaining({ name: "Reels", created: true, tagged: 1 })]);
    const items = api.showcases.get(showcase.id)!.images;
    expect(items).toHaveLength(2);
    expect(items.filter((item) => item.categoryIds.length > 0).map((item) => item.video!.title)).toEqual(["tour"]);
  });

  it("validates files in a dry run without contacting the API", async () => {
    await writeFiles(root, { "ok.mp4": mp4Bytes(200), "fake.mp4": "not a video", "photo.jpg": JPEG_BYTES, "doc.pdf": "%PDF" });
    const summary = await uploadVideos({ siteId: "site1", paths: [root], dryRun: true }, uploadContextFor(api, configDirectory));
    expect(summary).toMatchObject({ dryRun: true, toUpload: 1, photosIgnored: 1 });
    expect(summary.rejected.count).toBe(2);
    expect(api.requests).toHaveLength(0);
  });
});

describe("video helpers", () => {
  it("derives titles and byte ranges", () => {
    expect(videoTitleFromFileName("/a/b/Kitchen Tour.final.mp4")).toBe("Kitchen Tour.final");
    expect(videoTitleFromFileName(".mp4")).toBe(".mp4");
    expect(partByteRange(3, 1024, 2600)).toEqual({ start: 2048, end: 2600 });
    expect(() => partByteRange(4, 1024, 2600)).toThrow();
  });
});
