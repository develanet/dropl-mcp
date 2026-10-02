import { stat } from "node:fs/promises";
import path from "node:path";
import { MAX_GALLERY_CATEGORIES, MAX_GALLERY_IMAGES, MAX_GALLERY_UPLOADS_PER_REQUEST, type UsageSummaryResponse } from "@dropl/shared";
import { normalizeCategoryName } from "./categories.js";
import { UserFacingError } from "./errors.js";
import { collectFiles } from "./files.js";
import { formatBytes, truncateList } from "./format.js";
import { classifyPhoto, classifyVideo, mediaKindOf } from "./media.js";
import { MAX_LISTED_FILES, rejectedFromSkipped, summarizeRejected, type RejectedFile, type RejectedSummary } from "./upload-common.js";

const ROOT_FOLDER_LABEL = "(top level)";
const MAX_LISTED_FOLDERS = 30;

export interface PlanMigrationInput {
  path: string;
  cwd?: string;
  recursive?: boolean;
  categoryFromFolder?: boolean;
}

interface FolderPlan {
  folder: string;
  /** Category the folder's items would get, or null for top-level files or when categories are off. */
  category: string | null;
  photos: number;
  videos: number;
  photoBytes: string;
  videoBytes: string;
  sampleFiles: string[];
}

export interface MigrationPlan {
  path: string;
  totals: { photos: number; videos: number; photoBytes: string; videoBytes: string; totalBytes: string };
  folders: FolderPlan[];
  foldersOmitted: number;
  unsupported: RejectedSummary;
  photoBatches: number;
  categories: string[];
  exceedsShowcaseLimit: boolean;
  storage: { remaining: string; fits: boolean; uploadsSuspended: boolean } | null;
  warnings: string[];
  suggestedSteps: string[];
}

interface FolderTally {
  photos: number;
  videos: number;
  photoBytes: number;
  videoBytes: number;
  sampleFiles: string[];
}

const SAMPLE_FILES_PER_FOLDER = 3;

export async function planMigration(input: PlanMigrationInput, usage: UsageSummaryResponse | null): Promise<MigrationPlan> {
  const cwd = input.cwd ?? process.cwd();
  const resolvedPath = path.resolve(cwd, input.path);
  const targetStats = await stat(resolvedPath).catch(() => null);
  if (!targetStats) throw new UserFacingError(`No such file or folder: ${input.path}`);
  const categoryFromFolder = input.categoryFromFolder ?? true;
  const collected = await collectFiles([input.path], { cwd, recursive: input.recursive ?? true });

  const rejected: RejectedFile[] = rejectedFromSkipped(collected.skipped);
  const tallies = new Map<string, FolderTally>();
  for (const file of collected.files) {
    const kind = mediaKindOf(file.fileName);
    const classification =
      kind === "photo"
        ? await classifyPhoto(file.absolutePath, file.sizeBytes)
        : kind === "video"
          ? await classifyVideo(file.absolutePath, file.sizeBytes)
          : ({ accepted: false, reason: "unsupported_type", detail: "not a supported photo or video type" } as const);
    if (!classification.accepted) {
      rejected.push({ path: file.displayPath, reason: classification.reason, detail: classification.detail });
      continue;
    }
    const folder = file.topFolder ?? ROOT_FOLDER_LABEL;
    const tally = tallies.get(folder) ?? { photos: 0, videos: 0, photoBytes: 0, videoBytes: 0, sampleFiles: [] };
    if (kind === "photo") {
      tally.photos += 1;
      tally.photoBytes += file.sizeBytes;
    } else {
      tally.videos += 1;
      tally.videoBytes += file.sizeBytes;
    }
    if (tally.sampleFiles.length < SAMPLE_FILES_PER_FOLDER) tally.sampleFiles.push(file.relativePath);
    tallies.set(folder, tally);
  }

  const folderPlans: FolderPlan[] = [...tallies.entries()].map(([folder, tally]) => ({
    folder,
    category: categoryFromFolder && folder !== ROOT_FOLDER_LABEL ? normalizeCategoryName(folder) : null,
    photos: tally.photos,
    videos: tally.videos,
    photoBytes: formatBytes(tally.photoBytes),
    videoBytes: formatBytes(tally.videoBytes),
    sampleFiles: tally.sampleFiles,
  }));
  const photoCount = [...tallies.values()].reduce((sum, tally) => sum + tally.photos, 0);
  const videoCount = [...tallies.values()].reduce((sum, tally) => sum + tally.videos, 0);
  const photoBytes = [...tallies.values()].reduce((sum, tally) => sum + tally.photoBytes, 0);
  const videoBytes = [...tallies.values()].reduce((sum, tally) => sum + tally.videoBytes, 0);
  const totalBytes = photoBytes + videoBytes;
  const categories = [...new Set(folderPlans.map((plan) => plan.category).filter((name): name is string => name !== null))];
  const exceedsShowcaseLimit = photoCount + videoCount > MAX_GALLERY_IMAGES;

  const warnings: string[] = [];
  if (exceedsShowcaseLimit) {
    warnings.push(
      `${photoCount + videoCount} items is more than one showcase holds (${MAX_GALLERY_IMAGES}). Suggest several showcases, for example one per top-level folder, and upload each folder into its own showcase.`,
    );
  }
  if (categories.length > MAX_GALLERY_CATEGORIES) {
    warnings.push(`${categories.length} folders would become categories but a showcase allows ${MAX_GALLERY_CATEGORIES}; group folders or split into several showcases.`);
  }
  if (photoCount + videoCount === 0) warnings.push("No supported photos or videos were found.");

  let storage: MigrationPlan["storage"] = null;
  if (usage) {
    const remainingBytes = Math.max(0, usage.storage.limitBytes - usage.storage.usedBytes);
    storage = { remaining: formatBytes(remainingBytes), fits: totalBytes <= remainingBytes, uploadsSuspended: usage.uploadsSuspended };
    if (!storage.fits) warnings.push(`This is ${formatBytes(totalBytes)} but only ${storage.remaining} of storage is left on the plan.`);
    if (usage.uploadsSuspended) warnings.push(`Uploads are suspended on this account${usage.suspensionReason ? `: ${usage.suspensionReason}` : ""}.`);
  }

  const quotedPath = JSON.stringify(input.path);
  const suggestedSteps = [
    "Show this plan to the user and get explicit confirmation (site, showcase title(s), categories) before creating anything or uploading.",
    "list_sites, then pick the client site with the user or create_site { name, domain? }.",
    `create_showcase { siteId, title${categories.length > 0 ? ", showCategoryFilters: true" : ""} }${exceedsShowcaseLimit ? " — one per part when splitting" : ""}.`,
  ];
  if (photoCount > 0) {
    suggestedSteps.push(`upload_photos { showcaseId, paths: [${quotedPath}], categoryFromFolder: ${categoryFromFolder} } (${Math.ceil(photoCount / MAX_GALLERY_UPLOADS_PER_REQUEST)} batch(es); safe to re-run, finished files are skipped).`);
  }
  if (videoCount > 0) {
    suggestedSteps.push(`upload_videos { siteId, paths: [${quotedPath}], showcaseId, categoryFromFolder: ${categoryFromFolder} }.`);
  }
  suggestedSteps.push(
    "get_showcase to check processing, then get_embed_code { showcaseId } and paste the snippet into the project.",
    "Run the project's build to make sure it still compiles.",
  );

  const listedFolders = truncateList(folderPlans, MAX_LISTED_FOLDERS);
  return {
    path: resolvedPath,
    totals: {
      photos: photoCount,
      videos: videoCount,
      photoBytes: formatBytes(photoBytes),
      videoBytes: formatBytes(videoBytes),
      totalBytes: formatBytes(totalBytes),
    },
    folders: listedFolders.items,
    foldersOmitted: listedFolders.omitted,
    unsupported: summarizeRejected(rejected),
    photoBatches: Math.ceil(photoCount / MAX_GALLERY_UPLOADS_PER_REQUEST),
    categories: categories.slice(0, MAX_LISTED_FILES),
    exceedsShowcaseLimit,
    storage,
    warnings,
    suggestedSteps,
  };
}
