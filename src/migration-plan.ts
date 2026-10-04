import { stat } from "node:fs/promises";
import path from "node:path";
import {
  MAX_GALLERY_CATEGORIES,
  MAX_GALLERY_IMAGES,
  MAX_GALLERY_PROJECTS,
  MAX_GALLERY_UPLOADS_PER_REQUEST,
  PROJECT_TITLE_MAX_LENGTH,
  availableProjectSlug,
  collapseWhitespace,
  slugifyProjectTitle,
  type UsageSummaryResponse,
} from "@dropl/shared";
import { normalizeCategoryName } from "./categories.js";
import { UserFacingError } from "./errors.js";
import { collectFiles, type LocalFile } from "./files.js";
import { formatBytes, truncateList } from "./format.js";
import { classifyPhoto, classifyVideo, mediaKindOf } from "./media.js";
import { MAX_LISTED_FILES, rejectedFromSkipped, summarizeRejected, type RejectedFile, type RejectedSummary } from "./upload-common.js";

const ROOT_FOLDER_LABEL = "(top level)";
const MAX_LISTED_FOLDERS = 30;
const MAX_LISTED_PROJECTS = MAX_GALLERY_PROJECTS;
/** A subfolder with this name (any case) holds one folder per project, e.g. `public/projects/<project>/`. */
const PROJECTS_FOLDER_NAME = "projects";
const FOLDER_NAME_SEPARATORS = /[_-]+/g;
const WORD_START = /(^|\s)(\p{Ll})/gu;

export type MigrationLayout = "gallery" | "projects";

export interface PlanMigrationInput {
  path: string;
  cwd?: string;
  recursive?: boolean;
  categoryFromFolder?: boolean;
  /** Omitted: projects when the folder has a `projects/` subfolder of project folders, else gallery. */
  layout?: MigrationLayout;
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

interface Totals {
  photos: number;
  videos: number;
  photoBytes: string;
  videoBytes: string;
  totalBytes: string;
}

type StorageCheck = { remaining: string; fits: boolean; uploadsSuspended: boolean } | null;

export interface MigrationPlan {
  layout: "gallery";
  path: string;
  totals: Totals;
  folders: FolderPlan[];
  foldersOmitted: number;
  unsupported: RejectedSummary;
  photoBatches: number;
  categories: string[];
  exceedsShowcaseLimit: boolean;
  storage: StorageCheck;
  warnings: string[];
  suggestedSteps: string[];
}

interface ProjectPlan {
  folder: string;
  /** Absolute folder path to pass to upload_photos / upload_videos. */
  path: string;
  title: string;
  slug: string;
  photos: number;
  videos: number;
  photoBytes: string;
  videoBytes: string;
  sampleFiles: string[];
}

export interface ProjectsMigrationPlan {
  layout: "projects";
  layoutReason: string;
  path: string;
  /** The folder whose subfolders are the projects. */
  projectsPath: string;
  totals: Totals;
  projects: ProjectPlan[];
  projectsOmitted: number;
  /** Media that isn't inside a project folder; not part of this plan. */
  filesOutsideProjects: number;
  unsupported: RejectedSummary;
  photoBatches: number;
  exceedsShowcaseLimit: boolean;
  exceedsProjectLimit: boolean;
  storage: StorageCheck;
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

interface AcceptedFile {
  file: LocalFile;
  kind: "photo" | "video";
}

const SAMPLE_FILES_PER_FOLDER = 3;

function emptyTally(): FolderTally {
  return { photos: 0, videos: 0, photoBytes: 0, videoBytes: 0, sampleFiles: [] };
}

function addToTally(tally: FolderTally, { file, kind }: AcceptedFile): void {
  if (kind === "photo") {
    tally.photos += 1;
    tally.photoBytes += file.sizeBytes;
  } else {
    tally.videos += 1;
    tally.videoBytes += file.sizeBytes;
  }
  if (tally.sampleFiles.length < SAMPLE_FILES_PER_FOLDER) tally.sampleFiles.push(file.relativePath);
}

function totalsOf(tallies: Iterable<FolderTally>) {
  let photos = 0;
  let videos = 0;
  let photoBytes = 0;
  let videoBytes = 0;
  for (const tally of tallies) {
    photos += tally.photos;
    videos += tally.videos;
    photoBytes += tally.photoBytes;
    videoBytes += tally.videoBytes;
  }
  return {
    photos,
    videos,
    totalBytes: photoBytes + videoBytes,
    view: { photos, videos, photoBytes: formatBytes(photoBytes), videoBytes: formatBytes(videoBytes), totalBytes: formatBytes(photoBytes + videoBytes) },
  };
}

function storageCheck(usage: UsageSummaryResponse | null, totalBytes: number, warnings: string[]): StorageCheck {
  if (!usage) return null;
  const remainingBytes = Math.max(0, usage.storage.limitBytes - usage.storage.usedBytes);
  const storage = { remaining: formatBytes(remainingBytes), fits: totalBytes <= remainingBytes, uploadsSuspended: usage.uploadsSuspended };
  if (!storage.fits) warnings.push(`This is ${formatBytes(totalBytes)} but only ${storage.remaining} of storage is left on the plan.`);
  if (usage.uploadsSuspended) warnings.push(`Uploads are suspended on this account${usage.suspensionReason ? `: ${usage.suspensionReason}` : ""}.`);
  return storage;
}

/** "arched-entry_two-story" → "Arched Entry Two Story"; names with capitals keep them ("McAllen Residence"). */
export function projectTitleFromFolder(folderName: string): string {
  const spaced = collapseWhitespace(folderName.replace(FOLDER_NAME_SEPARATORS, " "));
  const title = spaced === spaced.toLowerCase() ? spaced.replace(WORD_START, (_match, space: string, letter: string) => `${space}${letter.toUpperCase()}`) : spaced;
  return title.slice(0, PROJECT_TITLE_MAX_LENGTH).trim() || folderName;
}

function isProjectsFolderName(name: string): boolean {
  return name.toLowerCase() === PROJECTS_FOLDER_NAME;
}

export async function planMigration(input: PlanMigrationInput, usage: UsageSummaryResponse | null): Promise<MigrationPlan | ProjectsMigrationPlan> {
  const cwd = input.cwd ?? process.cwd();
  const resolvedPath = path.resolve(cwd, input.path);
  const targetStats = await stat(resolvedPath).catch(() => null);
  if (!targetStats) throw new UserFacingError(`No such file or folder: ${input.path}`);
  const collected = await collectFiles([input.path], { cwd, recursive: input.recursive ?? true });

  const rejected: RejectedFile[] = rejectedFromSkipped(collected.skipped);
  const accepted: AcceptedFile[] = [];
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
    accepted.push({ file, kind: kind === "video" ? "video" : "photo" });
  }

  // A `projects/` subfolder holding project folders, unless the scanned folder is itself the projects folder.
  const projectsSubfolder = isProjectsFolderName(path.basename(resolvedPath))
    ? null
    : (accepted.find(({ file }) => file.topFolder !== null && isProjectsFolderName(file.topFolder) && file.relativePath.split("/").length > 2)?.file.topFolder ?? null);
  if (input.layout === "projects") {
    const reason = projectsSubfolder
      ? `layout: "projects" was requested; each subfolder of ${projectsSubfolder}/ is a project.`
      : `layout: "projects" was requested; each subfolder is a project.`;
    return planProjects(input, resolvedPath, accepted, rejected, projectsSubfolder, reason, usage);
  }
  if (input.layout === undefined && projectsSubfolder) {
    const reason = `Found a ${projectsSubfolder}/ folder of project folders, so each of its subfolders is planned as a project. Pass layout: "gallery" for one gallery with categories instead.`;
    return planProjects(input, resolvedPath, accepted, rejected, projectsSubfolder, reason, usage);
  }
  return planGallery(input, resolvedPath, accepted, rejected, usage);
}

function planGallery(
  input: PlanMigrationInput,
  resolvedPath: string,
  accepted: readonly AcceptedFile[],
  rejected: RejectedFile[],
  usage: UsageSummaryResponse | null,
): MigrationPlan {
  const categoryFromFolder = input.categoryFromFolder ?? true;
  const tallies = new Map<string, FolderTally>();
  for (const entry of accepted) {
    const folder = entry.file.topFolder ?? ROOT_FOLDER_LABEL;
    const tally = tallies.get(folder) ?? emptyTally();
    addToTally(tally, entry);
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
  const totals = totalsOf(tallies.values());
  const categories = [...new Set(folderPlans.map((plan) => plan.category).filter((name): name is string => name !== null))];
  const itemCount = totals.photos + totals.videos;
  const exceedsShowcaseLimit = itemCount > MAX_GALLERY_IMAGES;

  const warnings: string[] = [];
  if (exceedsShowcaseLimit) {
    warnings.push(
      `${itemCount} items is more than one showcase holds (${MAX_GALLERY_IMAGES}). Suggest several showcases, for example one per top-level folder, and upload each folder into its own showcase.`,
    );
  }
  if (categories.length > MAX_GALLERY_CATEGORIES) {
    warnings.push(`${categories.length} folders would become categories but a showcase allows ${MAX_GALLERY_CATEGORIES}; group folders or split into several showcases.`);
  }
  if (itemCount === 0) warnings.push("No supported photos or videos were found.");
  if (input.layout === undefined && isProjectsFolderName(path.basename(resolvedPath)) && tallies.size > 1) {
    warnings.push(`This folder is named "${path.basename(resolvedPath)}": if each subfolder is one project (a portfolio with a page per project), run plan_migration again with layout: "projects".`);
  }
  const storage = storageCheck(usage, totals.totalBytes, warnings);

  const quotedPath = JSON.stringify(input.path);
  const suggestedSteps = [
    "Show this plan to the user and get explicit confirmation (site, showcase title(s), categories) before creating anything or uploading.",
    "list_sites, then pick the client site with the user or create_site { name, domain? }.",
    `create_showcase { siteId, title${categories.length > 0 ? ", showCategoryFilters: true" : ""} }${exceedsShowcaseLimit ? " — one per part when splitting" : ""}.`,
  ];
  if (totals.photos > 0) {
    suggestedSteps.push(
      `upload_photos { showcaseId, paths: [${quotedPath}], categoryFromFolder: ${categoryFromFolder} } (${Math.ceil(totals.photos / MAX_GALLERY_UPLOADS_PER_REQUEST)} batch(es); safe to re-run, finished files are skipped).`,
    );
  }
  if (totals.videos > 0) {
    suggestedSteps.push(`upload_videos { siteId, paths: [${quotedPath}], showcaseId, categoryFromFolder: ${categoryFromFolder} }.`);
  }
  suggestedSteps.push(
    "get_showcase to check processing, then get_embed_code { showcaseId } and paste the snippet into the project.",
    "Run the project's build to make sure it still compiles.",
  );

  const listedFolders = truncateList(folderPlans, MAX_LISTED_FOLDERS);
  return {
    layout: "gallery",
    path: resolvedPath,
    totals: totals.view,
    folders: listedFolders.items,
    foldersOmitted: listedFolders.omitted,
    unsupported: summarizeRejected(rejected),
    photoBatches: Math.ceil(totals.photos / MAX_GALLERY_UPLOADS_PER_REQUEST),
    categories: categories.slice(0, MAX_LISTED_FILES),
    exceedsShowcaseLimit,
    storage,
    warnings,
    suggestedSteps,
  };
}

function planProjects(
  input: PlanMigrationInput,
  resolvedPath: string,
  accepted: readonly AcceptedFile[],
  rejected: RejectedFile[],
  projectsSubfolder: string | null,
  layoutReason: string,
  usage: UsageSummaryResponse | null,
): ProjectsMigrationPlan {
  const projectsPath = projectsSubfolder ? path.join(resolvedPath, projectsSubfolder) : resolvedPath;
  // Files are sorted naturally, so first-seen folder order is the order the projects are planned in.
  const tallies = new Map<string, FolderTally>();
  let filesOutsideProjects = 0;
  for (const entry of accepted) {
    const segments = entry.file.relativePath.split("/");
    const inScope = projectsSubfolder ? segments[0] === projectsSubfolder : true;
    const projectSegments = projectsSubfolder ? segments.slice(1) : segments;
    if (!inScope || projectSegments.length < 2) {
      filesOutsideProjects += 1;
      continue;
    }
    const folder = projectSegments[0]!;
    const tally = tallies.get(folder) ?? emptyTally();
    addToTally(tally, entry);
    tallies.set(folder, tally);
  }

  const takenSlugs = new Set<string>();
  const projectPlans: ProjectPlan[] = [...tallies.entries()].map(([folder, tally]) => {
    const title = projectTitleFromFolder(folder);
    const slug = availableProjectSlug(slugifyProjectTitle(title), takenSlugs);
    takenSlugs.add(slug);
    return {
      folder,
      path: path.join(projectsPath, folder),
      title,
      slug,
      photos: tally.photos,
      videos: tally.videos,
      photoBytes: formatBytes(tally.photoBytes),
      videoBytes: formatBytes(tally.videoBytes),
      sampleFiles: tally.sampleFiles,
    };
  });
  const totals = totalsOf(tallies.values());
  const itemCount = totals.photos + totals.videos;
  const exceedsShowcaseLimit = itemCount > MAX_GALLERY_IMAGES;
  const exceedsProjectLimit = projectPlans.length > MAX_GALLERY_PROJECTS;

  const warnings: string[] = [];
  if (projectPlans.length === 0) {
    warnings.push(
      input.recursive === false
        ? "No project folders were scanned because recursive is false; run it again without recursive: false."
        : `No project folders with supported photos or videos were found in ${projectsPath}. Each project needs its own subfolder.`,
    );
  }
  if (exceedsProjectLimit) {
    warnings.push(`${projectPlans.length} projects is more than one showcase holds (${MAX_GALLERY_PROJECTS}). Suggest several projects showcases, for example by year or type.`);
  }
  if (exceedsShowcaseLimit) {
    warnings.push(`${itemCount} items across the projects is more than one showcase holds (${MAX_GALLERY_IMAGES}). Suggest several projects showcases, or fewer photos per project.`);
  }
  if (filesOutsideProjects > 0) {
    warnings.push(`${filesOutsideProjects} photos or videos aren't inside a project folder and aren't part of this plan; move them into a project folder or plan them separately.`);
  }
  if (input.categoryFromFolder) {
    warnings.push("categoryFromFolder doesn't apply to projects: folders become projects. Set each project's categories with create_project.");
  }
  const storage = storageCheck(usage, totals.totalBytes, warnings);

  const suggestedSteps = [
    "Show this plan to the user and get explicit confirmation (site, showcase title, the project titles and slugs, file counts) before creating anything or uploading. Titles come from folder names; let the user correct them.",
    "list_sites, then pick the client site with the user or create_site { name, domain? }.",
    `create_showcase { siteId, title, type: "projects" }${exceedsShowcaseLimit || exceedsProjectLimit ? " — one per part when splitting" : ""}.`,
    "If the projects share facts (location, year, size, type), define them once: get_project_details, then plan_project_details and apply_project_details after the user confirms.",
    `For each entry in projects, in order: create_project { showcaseId, title, slug } (with subtitle, description, details, and categories when the site has them), then upload_photos { showcaseId, project: slug, paths: [path] } (dryRun: true first; safe to re-run, finished files are skipped)${totals.videos > 0 ? ", and for folders with videos upload_videos { siteId, paths: [path], showcaseId, project: slug }" : ""}.`,
    'list_projects to check each project, then get_embed_code { showcaseId } (or with projectUrl, e.g. "/work/{slug}", when the website has a page per project) and paste the snippet into the project.',
    "Run the project's build to make sure it still compiles.",
  ];

  const listedProjects = truncateList(projectPlans, MAX_LISTED_PROJECTS);
  return {
    layout: "projects",
    layoutReason,
    path: resolvedPath,
    projectsPath,
    totals: totals.view,
    projects: listedProjects.items,
    projectsOmitted: listedProjects.omitted,
    filesOutsideProjects,
    unsupported: summarizeRejected(rejected),
    photoBatches: projectPlans.reduce((sum, project) => sum + Math.ceil(project.photos / MAX_GALLERY_UPLOADS_PER_REQUEST), 0),
    exceedsShowcaseLimit,
    exceedsProjectLimit,
    storage,
    warnings,
    suggestedSteps,
  };
}
