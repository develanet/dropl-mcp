import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { UsageSummaryResponse } from "@dropl/shared";
import { planMigration } from "../src/migration-plan.js";
import { makeTempDirectory, mp4Bytes, PNG_BYTES, removeDirectory, uniqueJpeg, writeFiles } from "./helpers/fixtures.js";

describe("plan_migration", () => {
  let root: string;
  beforeEach(async () => {
    root = await makeTempDirectory();
    await writeFiles(root, {
      "site/Kitchens/k1.jpg": uniqueJpeg(1),
      "site/Kitchens/k2.png": PNG_BYTES,
      "site/Kitchens/tour.mp4": mp4Bytes(400),
      "site/Decks/d1.jpg": uniqueJpeg(2),
      "site/logo.jpg": uniqueJpeg(3),
      "site/notes.docx": "doc",
      "site/broken.jpg": "nope",
      "site/.DS_Store": "x",
    });
  });
  afterEach(() => removeDirectory(root));

  it("groups by top-level folder, counts media, lists unsupported files and suggests the tool calls", async () => {
    const plan = await planMigration({ path: "site", cwd: root }, null);

    expect(plan.totals).toMatchObject({ photos: 4, videos: 1 });
    const folders = Object.fromEntries(plan.folders.map((folder) => [folder.folder, folder]));
    expect(folders.Kitchens).toMatchObject({ category: "Kitchens", photos: 2, videos: 1 });
    expect(folders.Decks).toMatchObject({ category: "Decks", photos: 1, videos: 0 });
    expect(folders["(top level)"]).toMatchObject({ category: null, photos: 1 });
    expect(plan.categories.sort()).toEqual(["Decks", "Kitchens"]);
    expect(plan.unsupported.byReason).toEqual({
      "unsupported file type": 1,
      "contents don't match a supported format": 1,
      "hidden file or folder": 1,
    });
    expect(plan.photoBatches).toBe(1);
    expect(plan.exceedsShowcaseLimit).toBe(false);
    expect(plan.storage).toBeNull();
    const steps = plan.suggestedSteps.join("\n");
    expect(steps).toMatch(/confirmation/);
    expect(steps).toContain("upload_photos");
    expect(steps).toContain("upload_videos");
    expect(steps).toContain("get_embed_code");
  });

  it("includes remaining storage when usage is known", async () => {
    const usage = { storage: { usedBytes: 9_999_900, limitBytes: 10_000_000 }, uploadsSuspended: true, suspensionReason: "Payment failed" } as UsageSummaryResponse;
    const plan = await planMigration({ path: "site", cwd: root, categoryFromFolder: false }, usage);
    expect(plan.storage).toEqual({ remaining: "100 B", fits: false, uploadsSuspended: true });
    expect(plan.categories).toEqual([]);
    expect(plan.warnings.join(" ")).toContain("Payment failed");
  });

  it("errors clearly for a missing folder", async () => {
    await expect(planMigration({ path: "missing", cwd: root }, null)).rejects.toThrow(/No such file or folder/);
  });
});
