import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import {
  MAX_GALLERY_IMAGES,
  MAX_GALLERY_ITEMS_PER_UPDATE,
  MAX_GALLERY_UPLOADS_PER_REQUEST,
  normalizeAltText,
  type BulkUpdateGalleryItemsRequest,
  type BulkUpdateGalleryItemsResponse,
  type CompleteGalleryUploadsRequest,
  type CompleteGalleryUploadsResponse,
  type CreateGalleryUploadsRequest,
  type CreateGalleryUploadsResponse,
  type GalleryDetail,
  type GalleryImageContentType,
  type GalleryImageSummary,
  type GalleryUploadTarget,
} from "@dropl/shared";
import { bulkTagItems, categoryKey, ensureCategories, normalizeCategoryName, showcasePath, type CategoryRef } from "./categories.js";
import { chunk, mapWithConcurrency } from "./concurrency.js";
import { describeError, UserFacingError } from "./errors.js";
import { collectFiles, type LocalFile } from "./files.js";
import { deriveIdempotencyKey } from "./idempotency.js";
import { UploadManifest, manifestPath, photoManifestName, type PhotoManifestEntry } from "./manifest.js";
import { classifyPhoto, mediaKindOf } from "./media.js";
import { isRetriableStorageStatus, retryDelayMs } from "./retry.js";
import { LocalReadError, StoragePutError } from "./storage-put.js";
import {
  fileChangedSinceScan,
  isBlockingError,
  rejectedFromSkipped,
  summarizeFailed,
  summarizeFileIds,
  summarizeRejected,
  uploadFileName,
  type FailedSummary,
  type MediaUploadContext,
  type RejectedFile,
  type RejectedSummary,
  type UploadedFileList,
  type UploadedFileRecord,
} from "./upload-common.js";

export const PHOTO_PUT_CONCURRENCY = 4;
export const MAX_PHOTO_PUT_ATTEMPTS = 4;
/** Fresh presign rounds for photos whose upload URLs expired or were refused. */
const MAX_PRESIGN_ROUNDS = 3;
/** Replayed upload URLs with less time than this left are re-requested under a new key. */
const UPLOAD_URL_MIN_REMAINING_MS = 5 * 60 * 1000;
const HTTP_FORBIDDEN = 403;
const PHOTO_NOT_SAVED_MESSAGE = "Uploaded but not saved by Dropl; re-run upload_photos to try again.";

/** Per-file settings; `path` may also be a folder or glob, applying them to every photo it matches. */
export interface PhotoFileOptions {
  path: string;
  /** Empty or null marks the photo decorative (no alt text). Omitted leaves the alt text as it is. */
  alt?: string | null;
  categories?: string[];
}

export interface UploadPhotosInput {
  showcaseId: string;
  paths?: string[];
  /** Uploaded too, so they don't need repeating in `paths`. */
  files?: PhotoFileOptions[];
  cwd?: string;
  recursive?: boolean;
  categoryFromFolder?: boolean;
  categories?: string[];
  dryRun?: boolean;
}

export interface PhotoUploadSummary {
  showcaseId: string;
  showcaseTitle: string;
  dryRun: boolean;
  /** Dry run: what would be uploaded. */
  toUpload: number;
  uploaded: number;
  alreadyUploaded: number;
  failed: FailedSummary;
  rejected: RejectedSummary;
  videosIgnored: number;
  duplicatesIgnored: number;
  batches: number;
  categories: { name: string; id: string | null; created: boolean; tagged: number }[];
  /** Photos whose alt text was saved this run (with the upload, or changed on ones already uploaded). */
  altTextSet: number;
  /** Every accepted photo's local path and showcase item id, including ones skipped as already uploaded. */
  files: UploadedFileList;
  showcaseItemCount: number;
  remainingCapacity: number;
  stoppedReason: string | null;
  warnings: string[];
  nextSteps: string[];
}

interface PlannedPhoto {
  file: LocalFile;
  contentType: GalleryImageContentType;
  categoryNames: string[];
  /** Normalized; undefined when the caller didn't set it. */
  altText: string | null | undefined;
}

interface ResolvedFileOptions {
  altText?: string | null;
  categoryNames: string[];
}

type PutOutcome = { kind: "uploaded" } | { kind: "expired" } | { kind: "failed"; error: string };

class PhotoUploadRun {
  private readonly concurrency: number;
  private readonly batchSize: number;
  private readonly uploadsPath: string;
  readonly uploadedImageIds = new Map<string, string>();
  readonly failed: { path: string; error: string }[] = [];
  /** By fingerprint; the image id when Dropl had already created the item. */
  readonly failures = new Map<string, { error: string; imageId: string | null }>();
  stoppedReason: string | null = null;
  private progressDone = 0;

  constructor(
    private readonly context: MediaUploadContext,
    private readonly showcaseId: string,
    private readonly manifest: UploadManifest<PhotoManifestEntry>,
    private readonly progressTotal: number,
  ) {
    this.concurrency = context.concurrency ?? PHOTO_PUT_CONCURRENCY;
    this.batchSize = Math.min(context.batchSize ?? MAX_GALLERY_UPLOADS_PER_REQUEST, MAX_GALLERY_UPLOADS_PER_REQUEST);
    this.uploadsPath = `${showcasePath(showcaseId)}/photos/uploads`;
  }

  private setManifest(photo: PlannedPhoto, imageId: string, status: PhotoManifestEntry["status"]): void {
    this.manifest.set(photo.file.fingerprint, {
      path: photo.file.absolutePath,
      imageId,
      status,
      updatedAt: new Date(this.context.now()).toISOString(),
    });
  }

  private fail(photo: PlannedPhoto, error: string, imageId: string | null = null): void {
    this.failed.push({ path: photo.file.displayPath, error });
    this.failures.set(photo.file.fingerprint, { error, imageId });
  }

  private reportProgress(message: string): void {
    this.progressDone += 1;
    this.context.onProgress?.(this.progressDone, this.progressTotal, message);
  }

  async uploadAll(photos: readonly PlannedPhoto[]): Promise<number> {
    const batches = chunk(photos, this.batchSize);
    for (const [batchIndex, batch] of batches.entries()) {
      if (this.stoppedReason) {
        for (const photo of batches.slice(batchIndex).flat()) this.fail(photo, "Not attempted: the upload stopped early.");
        break;
      }
      let pending: PlannedPhoto[] = batch;
      for (let round = 0; round < MAX_PRESIGN_ROUNDS && pending.length > 0 && !this.stoppedReason; round += 1) {
        pending = await this.uploadBatch(pending, round);
      }
      for (const photo of pending) this.fail(photo, "Storage kept refusing the upload URL; re-run upload_photos to try again.");
    }
    return batches.length;
  }

  /** Returns the photos whose upload URLs were refused, to be presigned again. */
  private async uploadBatch(photos: PlannedPhoto[], round: number): Promise<PlannedPhoto[]> {
    const body: CreateGalleryUploadsRequest = {
      files: photos.map((photo) => ({
        fileName: uploadFileName(photo.file.fileName),
        contentType: photo.contentType,
        sizeBytes: photo.file.sizeBytes,
        ...(photo.altText && { altText: photo.altText }),
      })),
    };
    const fingerprints = photos.map((photo) => photo.file.fingerprint);
    // Alt text joins the key only when set, so batches without it keep the keys earlier versions sent.
    const altTexts = photos.map((photo) => photo.altText ?? null);
    const altTextKey = altTexts.some((altText) => altText !== null) ? [altTexts] : [];

    let targets: GalleryUploadTarget[];
    try {
      targets = await this.presign(body, fingerprints, round, altTextKey);
    } catch (error) {
      const message = describeError(error);
      if (isBlockingError(error)) this.stoppedReason = message;
      for (const photo of photos) this.fail(photo, message);
      return [];
    }

    photos.forEach((photo, index) => this.setManifest(photo, targets[index]!.imageId, "registered"));
    await this.manifest.save();

    const outcomes = await mapWithConcurrency(photos, this.concurrency, async (photo, index) => {
      const outcome = await this.putPhoto(photo, targets[index]!);
      this.reportProgress(`${photo.file.displayPath}: ${outcome.kind}`);
      return outcome;
    });

    const uploaded: { photo: PlannedPhoto; imageId: string }[] = [];
    const expired: PlannedPhoto[] = [];
    outcomes.forEach((outcome, index) => {
      const photo = photos[index]!;
      if (outcome.kind === "uploaded") {
        uploaded.push({ photo, imageId: targets[index]!.imageId });
        this.setManifest(photo, targets[index]!.imageId, "uploaded");
      } else if (outcome.kind === "expired") {
        expired.push(photo);
        this.manifest.delete(photo.file.fingerprint);
      } else {
        this.fail(photo, outcome.error);
        this.manifest.delete(photo.file.fingerprint);
      }
    });
    await this.manifest.save();
    await this.complete(uploaded);
    return expired;
  }

  private async presign(
    body: CreateGalleryUploadsRequest,
    fingerprints: string[],
    round: number,
    extraKeyInputs: readonly unknown[],
  ): Promise<GalleryUploadTarget[]> {
    // A replay of a request from an earlier run returns its (possibly expired) URLs; a new generation gets fresh ones.
    for (let generation = 0; ; generation += 1) {
      const response = await this.context.client.request<CreateGalleryUploadsResponse>("POST", this.uploadsPath, {
        body,
        idempotencyKey: deriveIdempotencyKey("photos.uploads", this.showcaseId, fingerprints, round, generation, ...extraKeyInputs),
        signal: this.context.signal,
      });
      const expiresAt = Date.parse(response.data.expiresAt);
      const stale = response.replayed && (Number.isNaN(expiresAt) || expiresAt - this.context.now() < UPLOAD_URL_MIN_REMAINING_MS);
      if (stale && generation + 1 < MAX_PRESIGN_ROUNDS) continue;
      const uploads = response.data.uploads;
      if (!Array.isArray(uploads) || uploads.length !== body.files.length) {
        throw new Error(`Asked Dropl for ${body.files.length} upload URLs but got ${Array.isArray(uploads) ? uploads.length : 0}.`);
      }
      return uploads;
    }
  }

  private async putPhoto(photo: PlannedPhoto, target: GalleryUploadTarget): Promise<PutOutcome> {
    try {
      const current = await stat(photo.file.absolutePath);
      if (fileChangedSinceScan(photo.file, current)) return { kind: "failed", error: "The file changed while uploading; re-run to upload the new version." };
    } catch {
      return { kind: "failed", error: "The file was removed before it could be uploaded." };
    }
    for (let attempt = 1; ; attempt += 1) {
      try {
        await this.context.putFile({
          url: target.uploadUrl,
          headers: target.headers,
          body: () => createReadStream(photo.file.absolutePath),
          contentLength: photo.file.sizeBytes,
          signal: this.context.signal,
        });
        return { kind: "uploaded" };
      } catch (error) {
        if (error instanceof StoragePutError) {
          if (error.status === HTTP_FORBIDDEN) return { kind: "expired" };
          if (isRetriableStorageStatus(error.status) && attempt < MAX_PHOTO_PUT_ATTEMPTS) {
            await this.context.sleep(retryDelayMs(attempt, this.context.random), this.context.signal);
            continue;
          }
          return { kind: "failed", error: error.message };
        }
        if (error instanceof LocalReadError) return { kind: "failed", error: error.message };
        if (this.context.signal?.aborted) throw error;
        return { kind: "failed", error: describeError(error) };
      }
    }
  }

  async complete(entries: readonly { photo: PlannedPhoto; imageId: string }[]): Promise<void> {
    for (const batch of chunk(entries, MAX_GALLERY_UPLOADS_PER_REQUEST)) {
      // Sorted so a re-run sends the identical body under the identical key.
      const imageIds = batch.map((entry) => entry.imageId).sort();
      const body: CompleteGalleryUploadsRequest = { imageIds };
      let images: GalleryImageSummary[];
      try {
        const response = await this.context.client.post<CompleteGalleryUploadsResponse>(`${this.uploadsPath}/complete`, body, {
          idempotencyKey: deriveIdempotencyKey("photos.complete", this.showcaseId, imageIds),
          signal: this.context.signal,
        });
        images = response.images;
      } catch (error) {
        const message = describeError(error);
        if (isBlockingError(error)) this.stoppedReason = message;
        // Kept as "uploaded" in the manifest: they may be saved, and a re-run completes them again.
        for (const entry of batch) this.fail(entry.photo, `Uploaded, but saving it failed: ${message} Re-run upload_photos to finish.`, entry.imageId);
        await this.manifest.save();
        continue;
      }
      const imagesById = new Map(images.map((image) => [image.id, image]));
      for (const entry of batch) {
        const image = imagesById.get(entry.imageId);
        if (image?.status === "failed") {
          this.fail(entry.photo, image.failureReason ?? "Dropl couldn't process this photo.", entry.imageId);
          this.setManifest(entry.photo, entry.imageId, "failed");
        } else if (!image || image.status === "uploading") {
          this.fail(entry.photo, PHOTO_NOT_SAVED_MESSAGE);
          this.manifest.delete(entry.photo.file.fingerprint);
        } else {
          this.uploadedImageIds.set(entry.photo.file.fingerprint, entry.imageId);
          this.setManifest(entry.photo, entry.imageId, "completed");
        }
      }
      await this.manifest.save();
    }
  }
}

function categoryNamesFor(file: LocalFile, explicitNames: readonly string[], categoryFromFolder: boolean): string[] {
  const names = [...explicitNames];
  if (categoryFromFolder && file.topFolder) {
    const folderName = normalizeCategoryName(file.topFolder);
    if (folderName) names.push(folderName);
  }
  const seen = new Set<string>();
  return names.filter((name) => {
    const key = categoryKey(name);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Keyed by canonical path. A later entry's alt text wins; categories add up. */
async function resolveFileOptions(entries: readonly PhotoFileOptions[], cwd: string, recursive: boolean): Promise<Map<string, ResolvedFileOptions>> {
  const options = new Map<string, ResolvedFileOptions>();
  for (const entry of entries) {
    const categoryNames = (entry.categories ?? []).map(normalizeCategoryName).filter((name): name is string => name !== null);
    const { files } = await collectFiles([entry.path], { cwd, recursive });
    for (const file of files) {
      const current = options.get(file.absolutePath) ?? { categoryNames: [] };
      if (entry.alt !== undefined) current.altText = normalizeAltText(entry.alt);
      current.categoryNames.push(...categoryNames);
      options.set(file.absolutePath, current);
    }
  }
  return options;
}

async function saveAltTexts(
  context: MediaUploadContext,
  showcaseId: string,
  changes: readonly { id: string; altText: string | null }[],
  warnings: string[],
): Promise<number> {
  let saved = 0;
  for (const batch of chunk(changes, MAX_GALLERY_ITEMS_PER_UPDATE)) {
    const body: BulkUpdateGalleryItemsRequest = { items: batch.map((change) => ({ id: change.id, altText: change.altText })) };
    try {
      await context.client.request<BulkUpdateGalleryItemsResponse>("PATCH", `${showcasePath(showcaseId)}/items`, { body, signal: context.signal });
      saved += batch.length;
    } catch (error) {
      warnings.push(`Couldn't save the alt text of ${batch.length} photos: ${describeError(error)} Use update_items to retry.`);
    }
  }
  return saved;
}

export async function uploadPhotos(input: UploadPhotosInput, context: MediaUploadContext): Promise<PhotoUploadSummary> {
  const cwd = input.cwd ?? process.cwd();
  const dryRun = input.dryRun ?? false;
  const recursive = input.recursive ?? true;
  const fileEntries = input.files ?? [];
  const inputPaths = [...(input.paths ?? []), ...fileEntries.map((entry) => entry.path)];
  if (inputPaths.length === 0) throw new UserFacingError("Pass the photos to upload in paths or files.");
  const explicitCategories = (input.categories ?? []).map(normalizeCategoryName).filter((name): name is string => name !== null);
  const collected = await collectFiles(inputPaths, { cwd, recursive });
  const fileOptions = await resolveFileOptions(fileEntries, cwd, recursive);

  const rejected: RejectedFile[] = rejectedFromSkipped(collected.skipped);
  const planned: PlannedPhoto[] = [];
  let videosIgnored = 0;
  for (const file of collected.files) {
    const kind = mediaKindOf(file.fileName);
    if (kind === "video") {
      videosIgnored += 1;
      continue;
    }
    const classification = await classifyPhoto(file.absolutePath, file.sizeBytes);
    if (!classification.accepted) {
      rejected.push({ path: file.displayPath, reason: classification.reason, detail: classification.detail });
      continue;
    }
    const options = fileOptions.get(file.absolutePath);
    planned.push({
      file,
      contentType: classification.contentType,
      categoryNames: categoryNamesFor(file, [...explicitCategories, ...(options?.categoryNames ?? [])], input.categoryFromFolder ?? false),
      altText: options?.altText,
    });
  }

  const showcase = await context.client.get<GalleryDetail>(showcasePath(input.showcaseId), { signal: context.signal });
  const manifest = await UploadManifest.load<PhotoManifestEntry>(
    manifestPath(context.configDirectory, photoManifestName(input.showcaseId)),
    context.client.apiUrl,
    input.showcaseId,
    context.warn,
  );
  const itemsById = new Map(showcase.images.map((item) => [item.id, item]));

  const toUpload: PlannedPhoto[] = [];
  const toComplete: { photo: PlannedPhoto; imageId: string }[] = [];
  const alreadyUploaded: { photo: PlannedPhoto; item: GalleryImageSummary }[] = [];
  const previouslyFailed: { path: string; error: string }[] = [];
  /** Known before uploading: files already in the showcase (finished or failed) and ones waiting to be completed. */
  const knownRecords = new Map<string, UploadedFileRecord>();
  for (const photo of planned) {
    const entry = manifest.get(photo.file.fingerprint);
    const item = entry ? itemsById.get(entry.imageId) : undefined;
    const displayPath = photo.file.displayPath;
    if (!entry || !item) {
      toUpload.push(photo);
    } else if (item.status === "ready" || item.status === "processing") {
      alreadyUploaded.push({ photo, item });
      knownRecords.set(photo.file.fingerprint, { path: displayPath, id: item.id, status: "already_uploaded" });
    } else if (item.status === "failed") {
      const error = `Already in the showcase but failed to process: ${item.failureReason ?? "unknown reason"}`;
      previouslyFailed.push({ path: displayPath, error });
      knownRecords.set(photo.file.fingerprint, { path: displayPath, id: item.id, status: "failed", error });
    } else if (entry.status === "uploaded") {
      toComplete.push({ photo, imageId: entry.imageId });
    } else {
      toUpload.push(photo);
    }
  }

  const remainingCapacity = Math.max(0, MAX_GALLERY_IMAGES - showcase.images.length);
  const warnings: string[] = [];
  const capacityMessage =
    toUpload.length > remainingCapacity
      ? `This showcase has room for ${remainingCapacity} more items (limit ${MAX_GALLERY_IMAGES} per showcase) but ${toUpload.length} photos would be uploaded. Split them across several showcases (for example one per folder) and upload each part separately.`
      : null;
  if (collected.duplicateCount > 0) warnings.push(`${collected.duplicateCount} paths pointed at files already in the list and were counted once.`);

  const categoryNames = [...new Set([...toUpload, ...toComplete.map((entry) => entry.photo), ...alreadyUploaded.map((entry) => entry.photo)].flatMap((photo) => photo.categoryNames))];
  const batchCount = Math.ceil(toUpload.length / MAX_GALLERY_UPLOADS_PER_REQUEST);
  const moreIdsHint = `Call list_showcase_items with showcaseId "${showcase.id}" to page through every item with its local path, id, alt text, and categories.`;
  const fileList = (recordFor: (photo: PlannedPhoto) => UploadedFileRecord) => summarizeFileIds(planned.map(recordFor), moreIdsHint);
  const baseSummary = {
    showcaseId: showcase.id,
    showcaseTitle: showcase.title,
    toUpload: toUpload.length + toComplete.length,
    alreadyUploaded: alreadyUploaded.length,
    rejected: summarizeRejected(rejected),
    videosIgnored,
    duplicatesIgnored: collected.duplicateCount,
    showcaseItemCount: showcase.images.length,
    remainingCapacity,
  };

  if (dryRun) {
    if (capacityMessage) warnings.push(capacityMessage);
    const pendingIds = new Map(toComplete.map((entry) => [entry.photo.file.fingerprint, entry.imageId]));
    return {
      ...baseSummary,
      dryRun: true,
      uploaded: 0,
      failed: summarizeFailed(previouslyFailed),
      batches: batchCount,
      categories: categoryNames.map((name) => ({ name, id: null, created: false, tagged: 0 })),
      altTextSet: 0,
      files: fileList(
        (photo) =>
          knownRecords.get(photo.file.fingerprint) ?? { path: photo.file.displayPath, id: pendingIds.get(photo.file.fingerprint) ?? null, status: "pending" },
      ),
      stoppedReason: null,
      warnings,
      nextSteps: [
        "Show this plan to the user and ask for confirmation before uploading.",
        "Then call upload_photos again with the same arguments and dryRun: false.",
      ],
    };
  }
  if (capacityMessage) throw new UserFacingError(capacityMessage);

  const categories = categoryNames.length > 0 ? await ensureCategories(context.client, showcase.id, categoryNames, showcase.categories) : new Map<string, CategoryRef>();

  const run = new PhotoUploadRun(context, showcase.id, manifest, toUpload.length + toComplete.length);
  if (toComplete.length > 0) await run.complete(toComplete);
  await run.uploadAll(toUpload);

  const tagCounts = new Map<string, number>();
  const taggable = [
    ...alreadyUploaded.map(({ photo, item }) => ({ photo, imageId: item.id, existingCategoryIds: item.categoryIds })),
    ...[...toUpload, ...toComplete.map((entry) => entry.photo)].flatMap((photo) => {
      const imageId = run.uploadedImageIds.get(photo.file.fingerprint);
      return imageId ? [{ photo, imageId, existingCategoryIds: [] as string[] }] : [];
    }),
  ];
  for (const category of categories.values()) {
    const imageIds = taggable
      .filter(
        ({ photo, existingCategoryIds }) =>
          !existingCategoryIds.includes(category.id) && photo.categoryNames.some((name) => categories.get(categoryKey(name))?.id === category.id),
      )
      .map(({ imageId }) => imageId);
    if (imageIds.length === 0) continue;
    try {
      await bulkTagItems(context.client, showcase.id, imageIds, { addCategoryIds: [category.id] });
      tagCounts.set(category.id, imageIds.length);
    } catch (error) {
      warnings.push(`Couldn't tag ${imageIds.length} photos with "${category.name}": ${describeError(error)} Use tag_items to retry.`);
    }
  }

  // Photos presigned now carried their alt text; ones already in the showcase are updated where it differs.
  const finishedNow = (photo: PlannedPhoto) => run.uploadedImageIds.has(photo.file.fingerprint);
  const existingItems = [
    ...alreadyUploaded,
    ...toComplete.filter(({ photo }) => finishedNow(photo)).map(({ photo, imageId }) => ({ photo, item: itemsById.get(imageId) })),
  ];
  const altTextChanges = existingItems.flatMap(({ photo, item }) =>
    item && photo.altText !== undefined && photo.altText !== item.altText ? [{ id: item.id, altText: photo.altText }] : [],
  );
  const altTextsSaved = altTextChanges.length > 0 ? await saveAltTexts(context, showcase.id, altTextChanges, warnings) : 0;
  const altTextsUploaded = toUpload.filter((photo) => photo.altText && finishedNow(photo)).length;

  const failed = [...previouslyFailed, ...run.failed];
  const uploadedCount = run.uploadedImageIds.size;
  const nextSteps: string[] = [];
  if (uploadedCount > 0) nextSteps.push("New photos are processing and appear on the website once ready (usually within a minute); get_showcase shows their status.");
  if (failed.length > 0 || run.stoppedReason) nextSteps.push("Re-running upload_photos with the same arguments skips finished files and retries the rest.");
  nextSteps.push("Use the ids in files with update_items (alt text, categories) or tag_items; no re-upload is needed.");
  nextSteps.push(`Call get_embed_code with showcaseId "${showcase.id}" for the snippet to paste into the site.`);

  return {
    ...baseSummary,
    dryRun: false,
    uploaded: uploadedCount,
    failed: summarizeFailed(failed),
    batches: batchCount,
    categories: [...categories.values()].map((category) => ({ name: category.name, id: category.id, created: category.created, tagged: tagCounts.get(category.id) ?? 0 })),
    altTextSet: altTextsUploaded + altTextsSaved,
    files: fileList((photo) => {
      const { fingerprint, displayPath: path } = photo.file;
      const known = knownRecords.get(fingerprint);
      if (known) return known;
      const imageId = run.uploadedImageIds.get(fingerprint);
      if (imageId) return { path, id: imageId, status: "uploaded" };
      const failure = run.failures.get(fingerprint);
      return { path, id: failure?.imageId ?? null, status: "failed", error: failure?.error ?? "Not uploaded; re-run upload_photos to retry." };
    }),
    stoppedReason: run.stoppedReason,
    warnings,
    nextSteps,
  };
}
