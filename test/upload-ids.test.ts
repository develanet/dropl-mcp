import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { uploadPhotos } from "../src/photo-upload.js";
import { listItemsResult, localPathsByItemId, updateShowcaseItems } from "../src/showcase-items.js";
import { MAX_LISTED_FILE_IDS } from "../src/upload-common.js";
import { uploadVideos } from "../src/video-upload.js";
import { makeTempDirectory, mp4Bytes, removeDirectory, uniqueJpeg, uploadContextFor, writeFiles } from "./helpers/fixtures.js";
import { MockDroplApi } from "./helpers/mock-api.js";

const PRESIGN_PATH = /^\/v1\/showcases\/[^/]+\/photos\/uploads$/;
const ITEMS_PATH = /^\/v1\/showcases\/[^/]+\/items$/;
const VIDEO_SIZE_BYTES = 3000;

describe("upload ids and alt text", () => {
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

  it("maps every local path to its item id, including files skipped on a re-run", async () => {
    await writeFiles(root, { "a.jpg": uniqueJpeg(1), "b.jpg": uniqueJpeg(2) });
    const showcase = api.addShowcase();
    const context = uploadContextFor(api, configDirectory);

    const first = await uploadPhotos({ showcaseId: showcase.id, paths: ["."], cwd: root }, context);
    expect(first.files.count).toBe(2);
    expect(first.files.omitted).toBe(0);
    expect(first.files.items.map((file) => [file.path, file.status])).toEqual([
      ["a.jpg", "uploaded"],
      ["b.jpg", "uploaded"],
    ]);
    const ids = first.files.items.map((file) => file.id);
    expect(ids).toEqual(showcase.images.map((item) => item.id));

    await writeFiles(root, { "c.jpg": uniqueJpeg(3) });
    const second = await uploadPhotos({ showcaseId: showcase.id, paths: ["."], cwd: root }, context);
    expect(second.uploaded).toBe(1);
    expect(second.alreadyUploaded).toBe(2);
    expect(second.files.items).toEqual([
      { path: "a.jpg", id: ids[0], status: "already_uploaded" },
      { path: "b.jpg", id: ids[1], status: "already_uploaded" },
      { path: "c.jpg", id: showcase.images[2]!.id, status: "uploaded" },
    ]);
  });

  it("reports pending files without ids on a dry run and failed files with an error", async () => {
    await writeFiles(root, { "a.jpg": uniqueJpeg(1), "b.jpg": uniqueJpeg(2) });
    const showcase = api.addShowcase();

    const plan = await uploadPhotos({ showcaseId: showcase.id, paths: ["."], cwd: root, dryRun: true }, uploadContextFor(api, configDirectory));
    expect(plan.files.items).toEqual([
      { path: "a.jpg", id: null, status: "pending" },
      { path: "b.jpg", id: null, status: "pending" },
    ]);
    expect(api.requestsTo("POST", PRESIGN_PATH)).toHaveLength(0);

    api.fail("PUT", /^\/storage\/photo\//, 400, 10);
    const summary = await uploadPhotos({ showcaseId: showcase.id, paths: [root] }, uploadContextFor(api, configDirectory));
    expect(summary.files.items.every((file) => file.status === "failed" && typeof file.error === "string")).toBe(true);
  });

  it("caps the listed ids and says how to get the rest", async () => {
    const files: Record<string, Buffer> = {};
    const extra = 5;
    for (let index = 0; index < MAX_LISTED_FILE_IDS + extra; index += 1) files[`p-${String(index).padStart(3, "0")}.jpg`] = uniqueJpeg(index);
    await writeFiles(root, files);
    const showcase = api.addShowcase();

    const summary = await uploadPhotos({ showcaseId: showcase.id, paths: [root] }, uploadContextFor(api, configDirectory));

    expect(summary.files.count).toBe(MAX_LISTED_FILE_IDS + extra);
    expect(summary.files.items).toHaveLength(MAX_LISTED_FILE_IDS);
    expect(summary.files.omitted).toBe(extra);
    expect(summary.files.more).toContain("list_showcase_items");
  });

  it("sets per-file alt text and categories at upload time", async () => {
    await writeFiles(root, { "deck.jpg": uniqueJpeg(1), "kitchen.jpg": uniqueJpeg(2), "pattern.jpg": uniqueJpeg(3) });
    const showcase = api.addShowcase();

    const summary = await uploadPhotos(
      {
        showcaseId: showcase.id,
        files: [
          { path: path.join(root, "deck.jpg"), alt: "  Cedar deck   with glass railing at dusk ", categories: ["Decks"] },
          { path: path.join(root, "kitchen.jpg"), alt: "White kitchen with walnut island", categories: ["Kitchens"] },
          { path: path.join(root, "pattern.jpg"), alt: "" },
        ],
      },
      uploadContextFor(api, configDirectory),
    );

    expect(summary.uploaded).toBe(3);
    expect(summary.altTextSet).toBe(2);
    const presigned = api.requestsTo("POST", PRESIGN_PATH)[0]!.body.files;
    expect(presigned.map((file: { altText?: string }) => file.altText)).toEqual(["Cedar deck with glass railing at dusk", "White kitchen with walnut island", undefined]);
    const categoryName = (id: string) => showcase.categories.find((category) => category.id === id)?.name;
    expect(showcase.images.map((item) => [item.sourceFileName, item.altText, item.categoryIds.map(categoryName)])).toEqual([
      ["deck.jpg", "Cedar deck with glass railing at dusk", ["Decks"]],
      ["kitchen.jpg", "White kitchen with walnut island", ["Kitchens"]],
      ["pattern.jpg", null, []],
    ]);
  });

  it("keeps the presign idempotency key unchanged when no alt text is given", async () => {
    await writeFiles(root, { "a.jpg": uniqueJpeg(1) });
    const first = api.addShowcase();
    await uploadPhotos({ showcaseId: first.id, paths: [root] }, uploadContextFor(api, configDirectory));
    const plainKey = api.requestsTo("POST", PRESIGN_PATH)[0]!.headers["idempotency-key"];

    const freshConfigs = [await makeTempDirectory("dropl-mcp-config-"), await makeTempDirectory("dropl-mcp-config-")];
    try {
      await uploadPhotos({ showcaseId: first.id, files: [{ path: path.join(root, "a.jpg") }] }, uploadContextFor(api, freshConfigs[0]!));
      await uploadPhotos({ showcaseId: first.id, files: [{ path: path.join(root, "a.jpg"), alt: "A" }] }, uploadContextFor(api, freshConfigs[1]!));
    } finally {
      await Promise.all(freshConfigs.map(removeDirectory));
    }
    const keys = api.requestsTo("POST", PRESIGN_PATH).map((request) => request.headers["idempotency-key"]);
    expect(keys[1]).toBe(plainKey);
    expect(keys[2]).not.toBe(plainKey);
  });

  it("updates alt text and categories of already-uploaded photos on a re-run instead of re-uploading", async () => {
    await writeFiles(root, { "a.jpg": uniqueJpeg(1), "b.jpg": uniqueJpeg(2) });
    const showcase = api.addShowcase();
    const context = uploadContextFor(api, configDirectory);
    await uploadPhotos({ showcaseId: showcase.id, paths: [root] }, context);
    const putsBefore = api.storagePuts.length;

    const summary = await uploadPhotos(
      { showcaseId: showcase.id, files: [{ path: path.join(root, "a.jpg"), alt: "Front porch", categories: ["Porches"] }, { path: path.join(root, "b.jpg") }] },
      context,
    );

    expect(api.storagePuts.length).toBe(putsBefore);
    expect(summary.uploaded).toBe(0);
    expect(summary.altTextSet).toBe(1);
    expect(api.requestsTo("PATCH", ITEMS_PATH)[0]!.body).toEqual({ items: [{ id: showcase.images[0]!.id, altText: "Front porch" }] });
    expect(showcase.images.map((item) => item.altText)).toEqual(["Front porch", null]);
    expect(showcase.images[0]!.categoryIds).toHaveLength(1);
  });

  it("maps uploaded videos to their library ids and showcase item ids", async () => {
    await writeFiles(root, { "tour.mp4": mp4Bytes(VIDEO_SIZE_BYTES) });
    const showcase = api.addShowcase();
    const context = uploadContextFor(api, configDirectory);

    const summary = await uploadVideos({ siteId: "site1", paths: ["."], cwd: root, showcaseId: showcase.id }, context);
    const item = showcase.images[0]!;
    expect(summary.files.items).toEqual([{ path: "tour.mp4", id: item.video!.id, status: "uploaded", showcaseItemId: item.id }]);

    const rerun = await uploadVideos({ siteId: "site1", paths: ["."], cwd: root, showcaseId: showcase.id }, context);
    expect(rerun.files.items).toEqual([{ path: "tour.mp4", id: item.video!.id, status: "already_uploaded", showcaseItemId: item.id }]);
  });

  it("lists items with local paths, alt text and categories, and filters photos missing alt text", async () => {
    await writeFiles(root, { "a.jpg": uniqueJpeg(1), "b.jpg": uniqueJpeg(2), "c.jpg": uniqueJpeg(3) });
    const showcase = api.addShowcase();
    const context = uploadContextFor(api, configDirectory);
    await uploadPhotos({ showcaseId: showcase.id, files: [{ path: path.join(root, "a.jpg"), alt: "Porch", categories: ["Porches"] }], paths: [root] }, context);

    const paths = await localPathsByItemId(context.client, configDirectory, showcase, () => undefined);
    const all = listItemsResult(showcase, paths, { limit: 2 });
    expect(all.total).toBe(3);
    expect(all.nextOffset).toBe(2);
    expect(all.photosWithoutAltText).toBe(2);
    expect(all.items[0]).toMatchObject({ id: showcase.images[0]!.id, kind: "photo", alt: "Porch", categories: ["Porches"], fileName: "a.jpg" });
    expect(all.items[0]!.localPath).toBe(path.join(await import("node:fs/promises").then((fs) => fs.realpath(root)), "a.jpg"));

    const missing = listItemsResult(showcase, paths, { missingAlt: true });
    expect(missing.items.map((item) => item.fileName)).toEqual(["b.jpg", "c.jpg"]);
    expect(missing.nextOffset).toBeNull();
    expect(listItemsResult(showcase, paths, { category: "porches" }).total).toBe(1);
    expect(listItemsResult(showcase, paths, { search: "C.JPG" }).items.map((item) => item.fileName)).toEqual(["c.jpg"]);
    expect(() => listItemsResult(showcase, paths, { category: "Nope" })).toThrow(/No category "Nope"/);
  });

  it("bulk-updates alt text and categories by id, creating missing categories and skipping no-ops", async () => {
    await writeFiles(root, { "a.jpg": uniqueJpeg(1), "b.jpg": uniqueJpeg(2), "c.jpg": uniqueJpeg(3) });
    const showcase = api.addShowcase();
    const context = uploadContextFor(api, configDirectory);
    const uploaded = await uploadPhotos({ showcaseId: showcase.id, paths: [root], categories: ["Old"] }, context);
    const [a, b, c] = uploaded.files.items.map((file) => file.id!);

    const result = await updateShowcaseItems(context.client, showcase.id, [
      { id: a!, alt: "Stone patio", addCategories: ["Patios"], removeCategories: ["old"] },
      { id: b!, alt: "" },
      { id: c!, removeCategories: ["Missing"] },
      { id: b!, addCategories: ["Patios"] },
    ]);

    expect(result).toMatchObject({ updated: 2, unchanged: 1, failed: 0, altTextSet: 1, altTextCleared: 0, createdCategories: ["Patios"] });
    expect(result.warnings).toEqual(['No category "Missing" to remove; skipped.']);
    expect(result.items).toEqual([
      { id: a, alt: "Stone patio", categories: ["Patios"] },
      { id: b, alt: null, categories: ["Old", "Patios"] },
    ]);

    await expect(updateShowcaseItems(context.client, showcase.id, [{ id: "nope", alt: "x" }])).rejects.toThrow(/Not in showcase "Portfolio": nope/);
  });

  it("accepts library video ids in place of item ids", async () => {
    await writeFiles(root, { "tour.mp4": mp4Bytes(VIDEO_SIZE_BYTES) });
    const showcase = api.addShowcase();
    const context = uploadContextFor(api, configDirectory);
    const summary = await uploadVideos({ siteId: "site1", paths: [root], showcaseId: showcase.id }, context);

    const result = await updateShowcaseItems(context.client, showcase.id, [{ id: summary.files.items[0]!.id!, addCategories: ["Tours"] }]);

    expect(result.updated).toBe(1);
    expect(api.requestsTo("PATCH", ITEMS_PATH)[0]!.body.items[0].id).toBe(showcase.images[0]!.id);
  });
});
