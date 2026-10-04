import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { UsageSummaryResponse } from "@dropl/shared";
import { planMigration, projectTitleFromFolder, type MigrationPlan, type PlanMigrationInput, type ProjectsMigrationPlan } from "../src/migration-plan.js";
import { makeTempDirectory, mp4Bytes, PNG_BYTES, removeDirectory, uniqueJpeg, writeFiles } from "./helpers/fixtures.js";

async function planGallery(input: PlanMigrationInput, usage: UsageSummaryResponse | null = null): Promise<MigrationPlan> {
  const plan = await planMigration(input, usage);
  if (plan.layout !== "gallery") throw new Error(`Expected a gallery plan, got ${plan.layout}`);
  return plan;
}

async function planProjects(input: PlanMigrationInput): Promise<ProjectsMigrationPlan> {
  const plan = await planMigration(input, null);
  if (plan.layout !== "projects") throw new Error(`Expected a projects plan, got ${plan.layout}`);
  return plan;
}

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
    const plan = await planGallery({ path: "site", cwd: root });

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
    const plan = await planGallery({ path: "site", cwd: root, categoryFromFolder: false }, usage);
    expect(plan.storage).toEqual({ remaining: "100 B", fits: false, uploadsSuspended: true });
    expect(plan.categories).toEqual([]);
    expect(plan.warnings.join(" ")).toContain("Payment failed");
  });

  it("errors clearly for a missing folder", async () => {
    await expect(planMigration({ path: "missing", cwd: root }, null)).rejects.toThrow(/No such file or folder/);
  });

  describe("projects layout", () => {
    beforeEach(async () => {
      await writeFiles(root, {
        "portfolio/projects/arched-entry_two-story/front.jpg": uniqueJpeg(10),
        "portfolio/projects/arched-entry_two-story/back.jpg": uniqueJpeg(11),
        "portfolio/projects/arched-entry_two-story/walkthrough.mp4": mp4Bytes(300),
        "portfolio/projects/McAllen Residence/hall.jpg": uniqueJpeg(12),
        "portfolio/projects/McAllen Residence/details/stair.jpg": uniqueJpeg(13),
        "portfolio/projects/loose.jpg": uniqueJpeg(14),
        "portfolio/hero.jpg": uniqueJpeg(15),
      });
    });

    it("plans one project per folder of a projects/ subfolder, with titles, slugs and per-project counts", async () => {
      const plan = await planProjects({ path: "portfolio", cwd: root });

      expect(plan.layoutReason).toMatch(/projects\//);
      expect(plan.projectsPath).toBe(path.join(root, "portfolio", "projects"));
      expect(plan.projects.map(({ folder, title, slug, photos, videos }) => ({ folder, title, slug, photos, videos }))).toEqual([
        { folder: "arched-entry_two-story", title: "Arched Entry Two Story", slug: "arched-entry-two-story", photos: 2, videos: 1 },
        { folder: "McAllen Residence", title: "McAllen Residence", slug: "mcallen-residence", photos: 2, videos: 0 },
      ]);
      expect(plan.projects[0]!.path).toBe(path.join(root, "portfolio", "projects", "arched-entry_two-story"));
      expect(plan.totals).toMatchObject({ photos: 4, videos: 1 });
      expect(plan.filesOutsideProjects).toBe(2);
      expect(plan.photoBatches).toBe(2);
      expect(plan.exceedsProjectLimit).toBe(false);
      const steps = plan.suggestedSteps.join("\n");
      expect(steps).toContain('type: "projects"');
      expect(steps).toContain("create_project");
      expect(steps).toContain("project: slug");
      expect(steps).toMatch(/confirmation/);
    });

    it("treats each subfolder as a project when layout is projects", async () => {
      const plan = await planProjects({ path: "portfolio/projects", cwd: root, layout: "projects", categoryFromFolder: true });

      expect(plan.projectsPath).toBe(path.join(root, "portfolio", "projects"));
      expect(plan.projects.map((project) => project.slug)).toEqual(["arched-entry-two-story", "mcallen-residence"]);
      expect(plan.filesOutsideProjects).toBe(1);
      expect(plan.warnings.join(" ")).toMatch(/categoryFromFolder doesn't apply/);
    });

    it("keeps planning a gallery with categories when asked, and hints at the projects layout for a projects folder", async () => {
      const forced = await planGallery({ path: "portfolio", cwd: root, layout: "gallery" });
      expect(forced.categories).toEqual(["projects"]);

      const projectsFolder = await planGallery({ path: "portfolio/projects", cwd: root });
      expect(projectsFolder.categories.sort()).toEqual(["McAllen Residence", "arched-entry_two-story"]);
      expect(projectsFolder.warnings.join(" ")).toContain('layout: "projects"');
    });

    it("gives clashing folder titles distinct slugs", async () => {
      await writeFiles(root, { "clash/Oak House/a.jpg": uniqueJpeg(20), "clash/oak-house/b.jpg": uniqueJpeg(21) });
      const plan = await planProjects({ path: "clash", cwd: root, layout: "projects" });
      expect(new Set(plan.projects.map((project) => project.slug)).size).toBe(2);
    });
  });

  it("humanizes folder names into project titles", () => {
    expect(projectTitleFromFolder("kitchen_remodel-2024")).toBe("Kitchen Remodel 2024");
    expect(projectTitleFromFolder("McAllen-Residence")).toBe("McAllen Residence");
    expect(projectTitleFromFolder("___")).toBe("___");
  });
});
