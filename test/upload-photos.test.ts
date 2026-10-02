import { open } from "node:fs/promises";
import path from "node:path";
import { MAX_GALLERY_IMAGE_SIZE_BYTES, MAX_GALLERY_IMAGES } from "@dropl/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { uploadPhotos } from "../src/photo-upload.js";
import { makeTempDirectory, PNG_BYTES, removeDirectory, uniqueJpeg, uploadContextFor, writeFiles, HEIC_BYTES } from "./helpers/fixtures.js";
import { MockDroplApi } from "./helpers/mock-api.js";

const PRESIGN_PATH = /^\/v1\/showcases\/[^/]+\/photos\/uploads$/;
const COMPLETE_PATH = /^\/v1\/showcases\/[^/]+\/photos\/uploads\/complete$/;

describe("upload_photos", () => {
  let api: MockDroplApi;
  let root: string;
  let configDirectory: string;

  beforeEach(async () => {
    api = new MockDroplApi();
    await api.start();
    root = await makeTempDirectory();
    configDirectory = await makeTempDirectory("dropl-mcp-config-");
  });
  afterEach(async () => {
    await api.stop();
    await removeDirectory(root);
    await removeDirectory(configDirectory);
  });

  it("uploads 205 photos in 3 batches of at most 100 and streams them to storage without auth", async () => {
    const files: Record<string, Buffer> = {};
    for (let index = 0; index < 205; index += 1) files[`shoot/photo-${index}.jpg`] = uniqueJpeg(index);
    await writeFiles(root, files);
    const showcase = api.addShowcase();
    const progress: number[] = [];

    const summary = await uploadPhotos(
      { showcaseId: showcase.id, paths: ["shoot"], cwd: root },
      uploadContextFor(api, configDirectory, { onProgress: (done) => progress.push(done) }),
    );

    expect(summary).toMatchObject({ uploaded: 205, alreadyUploaded: 0, batches: 3, stoppedReason: null });
    expect(summary.failed.count).toBe(0);
    const presigns = api.requestsTo("POST", PRESIGN_PATH);
    expect(presigns.map((request) => request.body.files.length)).toEqual([100, 100, 5]);
    expect(new Set(presigns.map((request) => request.headers["idempotency-key"])).size).toBe(3);
    expect(api.requestsTo("POST", COMPLETE_PATH).map((request) => request.body.imageIds.length)).toEqual([100, 100, 5]);
    expect(api.requestsTo("POST", COMPLETE_PATH).every((request) => typeof request.headers["idempotency-key"] === "string")).toBe(true);
    expect(api.storagePuts).toHaveLength(205);
    expect(api.storagePuts.every((put) => put.authorization === undefined && put.contentType === "image/jpeg")).toBe(true);
    expect(progress.at(-1)).toBe(205);
    expect(summary.nextSteps.join(" ")).toContain("get_embed_code");
  });

  it("rejects bad content, oversized, empty and unsupported files and ignores videos", async () => {
    await writeFiles(root, {
      "ok.jpg": uniqueJpeg(1),
      "photo.heic": HEIC_BYTES,
      "renamed.jpg": PNG_BYTES,
      "fake.jpg": "this is text",
      "empty.png": Buffer.alloc(0),
      "notes.txt": "hello",
      "anim.gif": "GIF89a",
      "clip.mp4": "video",
      ".DS_Store": "x",
    });
    const handle = await open(path.join(root, "huge.jpg"), "w");
    await handle.truncate(MAX_GALLERY_IMAGE_SIZE_BYTES + 1);
    await handle.close();
    const showcase = api.addShowcase();

    const summary = await uploadPhotos({ showcaseId: showcase.id, paths: [root] }, uploadContextFor(api, configDirectory));

    expect(summary.uploaded).toBe(3);
    expect(summary.videosIgnored).toBe(1);
    expect(summary.rejected.count).toBe(6);
    expect(summary.rejected.byReason).toEqual({
      "contents don't match a supported format": 1,
      "too large": 1,
      "empty file": 1,
      "unsupported file type": 2,
      "hidden file or folder": 1,
    });
    expect(summary.rejected.files.map((file) => file.path)).not.toContain(".DS_Store");
    const types = api.requestsTo("POST", PRESIGN_PATH)[0]!.body.files.map((file: { fileName: string; contentType: string }) => [file.fileName, file.contentType]);
    expect(types).toEqual([
      ["ok.jpg", "image/jpeg"],
      ["photo.heic", "image/heic"],
      ["renamed.jpg", "image/png"],
    ]);
  });

  it("retries storage 500s with backoff, then succeeds", async () => {
    await writeFiles(root, { "a.jpg": uniqueJpeg(1), "b.jpg": uniqueJpeg(2) });
    const showcase = api.addShowcase();
    api.fail("PUT", /^\/storage\/photo\//, 500, 2);
    const context = uploadContextFor(api, configDirectory);

    const summary = await uploadPhotos({ showcaseId: showcase.id, paths: [root] }, context);

    expect(summary.uploaded).toBe(2);
    expect(summary.failed.count).toBe(0);
    expect(context.sleeps.length).toBeGreaterThanOrEqual(2);
    expect(api.storagePuts).toHaveLength(2);
  });

  it("re-presigns under a new key when storage refuses an upload URL (403)", async () => {
    await writeFiles(root, { "a.jpg": uniqueJpeg(1) });
    const showcase = api.addShowcase();
    api.fail("PUT", /^\/storage\/photo\//, 403, 1);

    const summary = await uploadPhotos({ showcaseId: showcase.id, paths: [root] }, uploadContextFor(api, configDirectory));

    expect(summary.uploaded).toBe(1);
    const keys = api.requestsTo("POST", PRESIGN_PATH).map((request) => request.headers["idempotency-key"]);
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("sends the same idempotency key on a re-run, so the API replays instead of duplicating", async () => {
    await writeFiles(root, { "a.jpg": uniqueJpeg(1), "b.jpg": uniqueJpeg(2), "c.jpg": uniqueJpeg(3) });
    const showcase = api.addShowcase();
    api.fail("PUT", /^\/storage\/photo\//, 400, 3);

    const firstRun = await uploadPhotos({ showcaseId: showcase.id, paths: [root] }, uploadContextFor(api, configDirectory));
    expect(firstRun.failed.count).toBe(3);
    const secondRun = await uploadPhotos({ showcaseId: showcase.id, paths: [root] }, uploadContextFor(api, configDirectory));

    expect(secondRun.uploaded).toBe(3);
    const keys = api.requestsTo("POST", PRESIGN_PATH).map((request) => request.headers["idempotency-key"]);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    expect(api.showcases.get(showcase.id)!.images).toHaveLength(3);
  });

  it("skips files already uploaded on a re-run, using the local manifest", async () => {
    await writeFiles(root, { "a.jpg": uniqueJpeg(1), "b.jpg": uniqueJpeg(2) });
    const showcase = api.addShowcase();
    await uploadPhotos({ showcaseId: showcase.id, paths: [root] }, uploadContextFor(api, configDirectory));
    const presignCount = api.requestsTo("POST", PRESIGN_PATH).length;

    await writeFiles(root, { "c.jpg": uniqueJpeg(3) });
    const rerun = await uploadPhotos({ showcaseId: showcase.id, paths: [root] }, uploadContextFor(api, configDirectory));

    expect(rerun).toMatchObject({ uploaded: 1, alreadyUploaded: 2 });
    expect(api.requestsTo("POST", PRESIGN_PATH)).toHaveLength(presignCount + 1);
    expect(api.requestsTo("POST", PRESIGN_PATH).at(-1)!.body.files.map((file: { fileName: string }) => file.fileName)).toEqual(["c.jpg"]);
    expect(api.storagePuts).toHaveLength(3);
  });

  it("completes photos that were uploaded before a failed complete, without re-uploading them", async () => {
    await writeFiles(root, { "a.jpg": uniqueJpeg(1) });
    const showcase = api.addShowcase();
    api.fail("POST", COMPLETE_PATH, 400, 1, { error: { code: "VALIDATION_FAILED", message: "Try again." } });

    const firstRun = await uploadPhotos({ showcaseId: showcase.id, paths: [root] }, uploadContextFor(api, configDirectory));
    expect(firstRun.failed.count).toBe(1);
    const secondRun = await uploadPhotos({ showcaseId: showcase.id, paths: [root] }, uploadContextFor(api, configDirectory));

    expect(secondRun.uploaded).toBe(1);
    expect(api.storagePuts).toHaveLength(1);
    expect(api.requestsTo("POST", PRESIGN_PATH)).toHaveLength(1);
  });

  it("stops early on a blocking error and says why", async () => {
    await writeFiles(root, { "a.jpg": uniqueJpeg(1) });
    const showcase = api.addShowcase();
    api.fail("POST", PRESIGN_PATH, 402, 1, { error: { code: "SUBSCRIPTION_REQUIRED", message: "Your trial has ended." } });

    const summary = await uploadPhotos({ showcaseId: showcase.id, paths: [root] }, uploadContextFor(api, configDirectory));

    expect(summary.uploaded).toBe(0);
    expect(summary.stoppedReason).toContain("Your trial has ended. (SUBSCRIPTION_REQUIRED, HTTP 402)");
  });

  it("creates categories from top-level folders, reuses existing ones, and tags photos", async () => {
    await writeFiles(root, {
      "work/Kitchens/k1.jpg": uniqueJpeg(1),
      "work/Kitchens/sub/k2.jpg": uniqueJpeg(2),
      "work/Bathrooms/b1.jpg": uniqueJpeg(3),
      "work/cover.jpg": uniqueJpeg(4),
    });
    const showcase = api.addShowcase("site1", {
      categories: [{ id: "existing-kitchens", name: "kitchens", slug: "kitchens", position: 0, itemCount: 0 }],
    });

    const summary = await uploadPhotos(
      { showcaseId: showcase.id, paths: [path.join(root, "work")], categoryFromFolder: true, categories: ["Portfolio"] },
      uploadContextFor(api, configDirectory),
    );

    expect(summary.uploaded).toBe(4);
    const byName = Object.fromEntries(summary.categories.map((category) => [category.name, category]));
    expect(byName.kitchens).toMatchObject({ id: "existing-kitchens", created: false, tagged: 2 });
    expect(byName.Bathrooms).toMatchObject({ created: true, tagged: 1 });
    expect(byName.Portfolio).toMatchObject({ created: true, tagged: 4 });
    const items = api.showcases.get(showcase.id)!.images;
    const cover = items.find((item) => item.sourceFileName === "cover.jpg")!;
    expect(cover.categoryIds).toEqual([byName.Portfolio!.id]);
  });

  it("refuses to overfill a showcase, but reports it in a dry run", async () => {
    await writeFiles(root, { "a.jpg": uniqueJpeg(1), "b.jpg": uniqueJpeg(2) });
    const showcase = api.addShowcase();
    for (let index = 0; index < MAX_GALLERY_IMAGES - 1; index += 1) {
      showcase.images.push({ ...showcase.images[0]!, id: `existing-${index}`, kind: "photo", status: "ready", categoryIds: [] } as never);
    }

    const dryRun = await uploadPhotos({ showcaseId: showcase.id, paths: [root], dryRun: true }, uploadContextFor(api, configDirectory));
    expect(dryRun).toMatchObject({ dryRun: true, toUpload: 2, remainingCapacity: 1 });
    expect(dryRun.warnings.join(" ")).toContain("Split them across several showcases");
    expect(api.requestsTo("POST", PRESIGN_PATH)).toHaveLength(0);

    await expect(uploadPhotos({ showcaseId: showcase.id, paths: [root] }, uploadContextFor(api, configDirectory))).rejects.toThrow(/room for 1 more/);
  });
});
