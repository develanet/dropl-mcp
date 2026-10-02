import { open, stat, type FileHandle } from "node:fs/promises";
import path from "node:path";
import {
  MAX_GALLERY_VIDEOS_PER_REQUEST,
  MAX_PRESIGNED_PARTS_PER_REQUEST,
  VIDEO_TITLE_MAX_LENGTH,
  type AddGalleryVideosRequest,
  type CompleteUploadResponse,
  type CreateUploadRequest,
  type CreateUploadResponse,
  type GalleryDetail,
  type PresignPartsRequest,
  type PresignPartsResponse,
  type UploadContentType,
  type UploadSessionResponse,
  type VideoDetail,
} from "@dropl/shared";
import { pathSegment } from "./api-client.js";
import { bulkTagItems, categoryKey, ensureCategories, normalizeCategoryName, showcasePath } from "./categories.js";
import { chunk, mapWithConcurrency } from "./concurrency.js";
import { DroplApiError, describeError } from "./errors.js";
import { collectFiles, type LocalFile } from "./files.js";
import { formatBytes, truncateList } from "./format.js";
import { deriveIdempotencyKey } from "./idempotency.js";
import { UploadManifest, manifestPath, videoManifestName, type VideoManifestEntry } from "./manifest.js";
import { classifyVideo, mediaKindOf } from "./media.js";
import { isRetriableStorageStatus, retryDelayMs } from "./retry.js";
import { StoragePutError } from "./storage-put.js";
import {
  MAX_LISTED_FILES,
  fileChangedSinceScan,
  isBlockingError,
  rejectedFromSkipped,
  summarizeFailed,
  summarizeRejected,
  uploadFileName,
  type FailedSummary,
  type MediaUploadContext,
  type RejectedFile,
  type RejectedSummary,
} from "./upload-common.js";

/** Memory stays bounded at partSizeBytes × this, since each in-flight part is read into its own buffer. */
export const VIDEO_PART_CONCURRENCY = 4;
export const MAX_PART_ATTEMPTS = 6;
/** Re-presign a part's URL this close to expiry rather than risk a 403 mid-part. */
const URL_REFRESH_MARGIN_MS = 2 * 60 * 1000;
/** New sessions tried for one file when earlier ones can't be resumed. */
const MAX_SESSION_GENERATIONS = 3;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_SERVER_ERROR_MIN = 500;
const FALLBACK_VIDEO_TITLE = "Untitled video";

export interface UploadVideosInput {
  siteId: string;
  paths: string[];
  cwd?: string;
  recursive?: boolean;
  showcaseId?: string;
  categories?: string[];
  categoryFromFolder?: boolean;
  dryRun?: boolean;
}

interface VideoRecord {
  path: string;
  title: string;
  videoId: string;
  publicId: string;
}

export interface VideoUploadSummary {
  siteId: string;
  dryRun: boolean;
  toUpload: number;
  totalBytes: string;
  uploaded: { count: number; videos: VideoRecord[]; omitted: number };
  alreadyUploaded: { count: number; videos: VideoRecord[]; omitted: number };
  failed: FailedSummary;
  rejected: RejectedSummary;
  photosIgnored: number;
  showcase: { id: string; videosAdded: number; categories: { name: string; id: string; created: boolean; tagged: number }[] } | null;
  stoppedReason: string | null;
  warnings: string[];
  nextSteps: string[];
}

interface PlannedVideo {
  file: LocalFile;
  contentType: UploadContentType;
  title: string;
  categoryNames: string[];
}

interface ActiveSession {
  uploadSessionId: string;
  videoId: string;
  publicId: string;
  partSizeBytes: number;
  partCount: number;
  uploadedPartNumbers: number[];
}

type VideoOutcome = { kind: "uploaded" | "skipped"; videoId: string; publicId: string };

export function videoTitleFromFileName(fileName: string): string {
  const title = path.basename(fileName, path.extname(fileName)).trim();
  return (title || FALLBACK_VIDEO_TITLE).slice(0, VIDEO_TITLE_MAX_LENGTH);
}

/** Part numbers start at 1; every part but the last is exactly `partSizeBytes`. */
export function partByteRange(partNumber: number, partSizeBytes: number, fileSizeBytes: number): { start: number; end: number } {
  if (!Number.isInteger(partNumber) || partNumber < 1) throw new Error(`Invalid part number: ${partNumber}`);
  const start = (partNumber - 1) * partSizeBytes;
  if (start >= fileSizeBytes) throw new Error(`Part ${partNumber} starts past the end of the file`);
  return { start, end: Math.min(start + partSizeBytes, fileSizeBytes) };
}

export function missingPartNumbers(partCount: number, uploadedPartNumbers: readonly number[]): number[] {
  const uploaded = new Set(uploadedPartNumbers);
  const missing: number[] = [];
  for (let partNumber = 1; partNumber <= partCount; partNumber += 1) if (!uploaded.has(partNumber)) missing.push(partNumber);
  return missing;
}

async function readExactly(handle: FileHandle, length: number, position: number): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await handle.read(buffer, offset, length - offset, position + offset);
    if (bytesRead === 0) throw new Error("The file got shorter while uploading.");
    offset += bytesRead;
  }
  return buffer;
}

class VideoUploadRun {
  private readonly concurrency: number;
  private uploadedBytes = 0;

  constructor(
    private readonly context: MediaUploadContext,
    private readonly siteId: string,
    private readonly manifest: UploadManifest<VideoManifestEntry>,
    private readonly totalBytes: number,
  ) {
    this.concurrency = context.concurrency ?? VIDEO_PART_CONCURRENCY;
  }

  private saveEntry(video: PlannedVideo, session: { uploadSessionId: string; videoId: string; publicId: string }, status: VideoManifestEntry["status"], generation: number) {
    this.manifest.set(video.file.fingerprint, {
      path: video.file.absolutePath,
      uploadSessionId: session.uploadSessionId,
      videoId: session.videoId,
      publicId: session.publicId,
      status,
      generation,
      updatedAt: new Date(this.context.now()).toISOString(),
    });
    return this.manifest.save();
  }

  private getSession(uploadSessionId: string): Promise<UploadSessionResponse> {
    return this.context.client.get<UploadSessionResponse>(`/v1/uploads/${pathSegment(uploadSessionId)}`, { signal: this.context.signal });
  }

  async upload(video: PlannedVideo): Promise<VideoOutcome> {
    const { client } = this.context;
    const entry = this.manifest.get(video.file.fingerprint);
    let generation = entry?.generation ?? 0;

    if (entry?.status === "completed") {
      try {
        const existing = await client.get<VideoDetail>(`/v1/videos/${pathSegment(entry.videoId)}`, { signal: this.context.signal });
        if (!existing.deletedAt) return { kind: "skipped", videoId: entry.videoId, publicId: entry.publicId };
      } catch (error) {
        if (!(error instanceof DroplApiError) || error.status !== HTTP_NOT_FOUND) throw error;
      }
      generation += 1;
    }

    let session: ActiveSession | null = null;
    if (entry?.status === "uploading") {
      const resumed = await this.resumeSession(entry.uploadSessionId, entry);
      if (resumed === "completed") {
        await this.saveEntry(video, entry, "completed", generation);
        return { kind: "uploaded", videoId: entry.videoId, publicId: entry.publicId };
      }
      if (resumed) session = resumed;
      else generation += 1;
    }

    while (!session) {
      if (generation >= (entry?.generation ?? 0) + MAX_SESSION_GENERATIONS) throw new Error("Couldn't start an upload session that can be resumed.");
      const body: CreateUploadRequest = {
        fileName: uploadFileName(video.file.fileName),
        contentType: video.contentType,
        sizeBytes: video.file.sizeBytes,
        title: video.title,
      };
      const response = await client.request<CreateUploadResponse>("POST", `/v1/sites/${pathSegment(this.siteId)}/videos/uploads`, {
        body,
        idempotencyKey: deriveIdempotencyKey("videos.uploads", this.siteId, video.file.fingerprint, generation),
        signal: this.context.signal,
      });
      const created = response.data;
      if (!response.replayed) {
        session = { ...created, uploadedPartNumbers: [] };
        break;
      }
      // A replay from an earlier run: carry on with that session if it can still take parts.
      const resumed = await this.resumeSession(created.uploadSessionId, created);
      if (resumed === "completed") {
        await this.saveEntry(video, created, "completed", generation);
        return { kind: "uploaded", videoId: created.videoId, publicId: created.publicId };
      }
      if (resumed) session = resumed;
      else generation += 1;
    }
    await this.saveEntry(video, session, "uploading", generation);

    const expectedPartCount = Math.ceil(video.file.sizeBytes / session.partSizeBytes);
    if (!(session.partSizeBytes > 0) || session.partCount !== expectedPartCount) {
      throw new Error(`Dropl's part plan (${session.partCount} × ${session.partSizeBytes} bytes) doesn't match the file size.`);
    }

    const handle = await open(video.file.absolutePath, "r");
    try {
      await this.uploadParts(video, session, handle, missingPartNumbers(session.partCount, session.uploadedPartNumbers));
      await this.complete(video, session, handle);
    } finally {
      await handle.close();
    }
    await this.saveEntry(video, session, "completed", generation);
    return { kind: "uploaded", videoId: session.videoId, publicId: session.publicId };
  }

  /** The session if it's still pending, "completed" if it already finished, or null if it's gone. */
  private async resumeSession(
    uploadSessionId: string,
    known: { videoId: string; publicId: string },
  ): Promise<ActiveSession | "completed" | null> {
    let remote: UploadSessionResponse;
    try {
      remote = await this.getSession(uploadSessionId);
    } catch (error) {
      if (error instanceof DroplApiError && error.status === HTTP_NOT_FOUND) return null;
      throw error;
    }
    if (remote.status === "completed") return "completed";
    if (remote.status !== "pending") return null;
    return {
      uploadSessionId,
      videoId: remote.videoId,
      publicId: known.publicId,
      partSizeBytes: remote.partSizeBytes,
      partCount: remote.partCount,
      uploadedPartNumbers: remote.uploadedPartNumbers,
    };
  }

  private async uploadParts(video: PlannedVideo, session: ActiveSession, handle: FileHandle, partNumbers: number[]): Promise<void> {
    const current = await stat(video.file.absolutePath);
    if (fileChangedSinceScan(video.file, current)) throw new Error("The file changed while uploading; re-run to upload the new version.");
    for (const uploaded of session.uploadedPartNumbers) {
      const { start, end } = partByteRange(uploaded, session.partSizeBytes, video.file.sizeBytes);
      this.addProgress(end - start, video);
    }

    const partsPath = `/v1/uploads/${pathSegment(session.uploadSessionId)}/parts`;
    const presign = async (numbers: number[]) => {
      const body: PresignPartsRequest = { partNumbers: numbers };
      const response = await this.context.client.post<PresignPartsResponse>(partsPath, body, { signal: this.context.signal });
      const expiresAt = Date.parse(response.urlsExpireAt);
      const urls = new Map<number, { url: string; expiresAt: number }>();
      for (const part of response.parts) urls.set(part.partNumber, { url: part.url, expiresAt });
      for (const number of numbers) if (!urls.has(number)) throw new Error(`Dropl didn't return an upload URL for part ${number}.`);
      return urls;
    };

    for (const batch of chunk(partNumbers, MAX_PRESIGNED_PARTS_PER_REQUEST)) {
      const urls = await presign(batch);
      await mapWithConcurrency(batch, this.concurrency, async (partNumber) => {
        const { start, end } = partByteRange(partNumber, session.partSizeBytes, video.file.sizeBytes);
        const bytes = await readExactly(handle, end - start, start);
        for (let attempt = 1; ; attempt += 1) {
          let target = urls.get(partNumber)!;
          if (Number.isNaN(target.expiresAt) || target.expiresAt - this.context.now() < URL_REFRESH_MARGIN_MS) {
            const refreshed = await presign([partNumber]);
            target = refreshed.get(partNumber)!;
            urls.set(partNumber, target);
          }
          try {
            await this.context.putFile({ url: target.url, body: bytes, contentLength: bytes.length, signal: this.context.signal });
            this.addProgress(bytes.length, video);
            return;
          } catch (error) {
            if (!(error instanceof StoragePutError)) throw error;
            const expired = error.status === HTTP_FORBIDDEN;
            if (!(expired || isRetriableStorageStatus(error.status)) || attempt >= MAX_PART_ATTEMPTS) {
              throw new Error(`Part ${partNumber} failed: ${error.message} Re-run upload_videos to resume from the parts already stored.`);
            }
            // Forces a fresh URL on the next attempt.
            if (expired) urls.set(partNumber, { ...target, expiresAt: Number.NaN });
            await this.context.sleep(retryDelayMs(attempt, this.context.random), this.context.signal);
          }
        }
      });
    }
  }

  private async complete(video: PlannedVideo, session: ActiveSession, handle: FileHandle): Promise<void> {
    const completePath = `/v1/uploads/${pathSegment(session.uploadSessionId)}/complete`;
    const idempotencyKey = deriveIdempotencyKey("videos.complete", session.uploadSessionId);
    try {
      await this.context.client.post<CompleteUploadResponse>(completePath, {}, { idempotencyKey, signal: this.context.signal });
      return;
    } catch (error) {
      if (!(error instanceof DroplApiError) || error.status === 0 || error.status >= HTTP_SERVER_ERROR_MIN) throw error;
      // The API may have found parts missing or the wrong size: upload whatever it lacks once, then try again.
      const remote = await this.getSession(session.uploadSessionId);
      if (remote.status === "completed") return;
      const missing = remote.status === "pending" ? missingPartNumbers(remote.partCount, remote.uploadedPartNumbers) : [];
      if (missing.length === 0) throw error;
      await this.uploadParts(video, { ...session, uploadedPartNumbers: [] }, handle, missing);
      await this.context.client.post<CompleteUploadResponse>(completePath, {}, {
        idempotencyKey: deriveIdempotencyKey("videos.complete", session.uploadSessionId, "after-repair"),
        signal: this.context.signal,
      });
    }
  }

  private addProgress(bytes: number, video: PlannedVideo): void {
    this.uploadedBytes += bytes;
    this.context.onProgress?.(this.uploadedBytes, this.totalBytes, `Uploading ${video.file.displayPath}`);
  }
}

function categoryNamesFor(file: LocalFile, explicitNames: readonly string[], categoryFromFolder: boolean): string[] {
  const names = [...explicitNames];
  const folderName = categoryFromFolder && file.topFolder ? normalizeCategoryName(file.topFolder) : null;
  if (folderName && !names.some((name) => categoryKey(name) === categoryKey(folderName))) names.push(folderName);
  return names;
}

export async function uploadVideos(input: UploadVideosInput, context: MediaUploadContext): Promise<VideoUploadSummary> {
  const cwd = input.cwd ?? process.cwd();
  const explicitCategories = [...new Set((input.categories ?? []).map(normalizeCategoryName).filter((name): name is string => name !== null))];
  const collected = await collectFiles(input.paths, { cwd, recursive: input.recursive ?? true });

  const rejected: RejectedFile[] = rejectedFromSkipped(collected.skipped);
  const planned: PlannedVideo[] = [];
  let photosIgnored = 0;
  for (const file of collected.files) {
    if (mediaKindOf(file.fileName) === "photo") {
      photosIgnored += 1;
      continue;
    }
    const classification = await classifyVideo(file.absolutePath, file.sizeBytes);
    if (!classification.accepted) {
      rejected.push({ path: file.displayPath, reason: classification.reason, detail: classification.detail });
      continue;
    }
    planned.push({
      file,
      contentType: classification.contentType,
      title: videoTitleFromFileName(file.fileName),
      categoryNames: input.showcaseId ? categoryNamesFor(file, explicitCategories, input.categoryFromFolder ?? false) : [],
    });
  }
  const totalBytes = planned.reduce((sum, video) => sum + video.file.sizeBytes, 0);
  const warnings: string[] = [];
  if (!input.showcaseId && (explicitCategories.length > 0 || input.categoryFromFolder)) {
    warnings.push("Categories only apply to videos in a showcase; pass showcaseId to add the videos to one.");
  }

  if (input.dryRun) {
    const listed = truncateList(
      planned.map((video) => ({ path: video.file.displayPath, title: video.title, videoId: "", publicId: "" })),
      MAX_LISTED_FILES,
    );
    return {
      siteId: input.siteId,
      dryRun: true,
      toUpload: planned.length,
      totalBytes: formatBytes(totalBytes),
      uploaded: { count: 0, videos: listed.items, omitted: listed.omitted },
      alreadyUploaded: { count: 0, videos: [], omitted: 0 },
      failed: summarizeFailed([]),
      rejected: summarizeRejected(rejected),
      photosIgnored,
      showcase: null,
      stoppedReason: null,
      warnings,
      nextSteps: ["Show this plan to the user and ask for confirmation, then call upload_videos again with dryRun: false."],
    };
  }

  const manifest = await UploadManifest.load<VideoManifestEntry>(
    manifestPath(context.configDirectory, videoManifestName(input.siteId)),
    context.client.apiUrl,
    input.siteId,
    context.warn,
  );
  const run = new VideoUploadRun(context, input.siteId, manifest, totalBytes);
  const uploaded: (VideoRecord & { video: PlannedVideo })[] = [];
  const skipped: (VideoRecord & { video: PlannedVideo })[] = [];
  const failed: { path: string; error: string }[] = [];
  let stoppedReason: string | null = null;

  for (const video of planned) {
    if (stoppedReason) {
      failed.push({ path: video.file.displayPath, error: "Not attempted: the upload stopped early." });
      continue;
    }
    try {
      const outcome = await run.upload(video);
      const record = { path: video.file.displayPath, title: video.title, videoId: outcome.videoId, publicId: outcome.publicId, video };
      (outcome.kind === "skipped" ? skipped : uploaded).push(record);
    } catch (error) {
      if (context.signal?.aborted) throw error;
      const message = describeError(error);
      if (isBlockingError(error)) stoppedReason = message;
      failed.push({ path: video.file.displayPath, error: message });
    }
  }

  let showcase: VideoUploadSummary["showcase"] = null;
  const finished = [...uploaded, ...skipped];
  if (input.showcaseId && finished.length > 0) {
    showcase = await addToShowcase(context, input.showcaseId, finished, warnings);
  }

  const nextSteps: string[] = [];
  if (uploaded.length > 0) nextSteps.push("Videos are processing (transcoding can take a few minutes); they appear on the website once ready.");
  if (failed.length > 0) nextSteps.push("Re-running upload_videos with the same arguments resumes unfinished uploads from the parts already stored.");
  if (showcase) nextSteps.push(`Call get_embed_code with showcaseId "${showcase.id}" for the showcase snippet.`);
  else if (finished.length > 0) nextSteps.push("Call get_embed_code with a videoId for each video's snippet, or add_videos_to_showcase to put them in a showcase.");

  const strip = ({ video: _video, ...record }: VideoRecord & { video: PlannedVideo }): VideoRecord => record;
  const uploadedList = truncateList(uploaded.map(strip), MAX_LISTED_FILES);
  const skippedList = truncateList(skipped.map(strip), MAX_LISTED_FILES);
  return {
    siteId: input.siteId,
    dryRun: false,
    toUpload: planned.length,
    totalBytes: formatBytes(totalBytes),
    uploaded: { count: uploaded.length, videos: uploadedList.items, omitted: uploadedList.omitted },
    alreadyUploaded: { count: skipped.length, videos: skippedList.items, omitted: skippedList.omitted },
    failed: summarizeFailed(failed),
    rejected: summarizeRejected(rejected),
    photosIgnored,
    showcase,
    stoppedReason,
    warnings,
    nextSteps,
  };
}

async function addToShowcase(
  context: MediaUploadContext,
  showcaseId: string,
  videos: readonly (VideoRecord & { video: PlannedVideo })[],
  warnings: string[],
): Promise<NonNullable<VideoUploadSummary["showcase"]>> {
  const { client } = context;
  let videosAdded = 0;
  for (const batch of chunk(videos, MAX_GALLERY_VIDEOS_PER_REQUEST)) {
    const body: AddGalleryVideosRequest = { videoIds: batch.map((video) => video.videoId) };
    try {
      await client.post<unknown>(`${showcasePath(showcaseId)}/videos`, body, { signal: context.signal });
      videosAdded += batch.length;
    } catch (error) {
      warnings.push(`Couldn't add ${batch.length} videos to the showcase: ${describeError(error)} Use add_videos_to_showcase to retry.`);
    }
  }

  const categoryNames = [...new Set(videos.flatMap((video) => video.video.categoryNames))];
  const categorySummaries: NonNullable<VideoUploadSummary["showcase"]>["categories"] = [];
  if (categoryNames.length === 0 || videosAdded === 0) return { id: showcaseId, videosAdded, categories: categorySummaries };

  try {
    const detail = await client.get<GalleryDetail>(showcasePath(showcaseId), { signal: context.signal });
    const categories = await ensureCategories(client, showcaseId, categoryNames, detail.categories);
    const itemsByVideoId = new Map(detail.images.filter((item) => item.video).map((item) => [item.video!.id, item]));
    for (const category of categories.values()) {
      const itemIds = videos
        .filter((video) => video.video.categoryNames.some((name) => categories.get(categoryKey(name))?.id === category.id))
        .map((video) => itemsByVideoId.get(video.videoId))
        .filter((item) => item !== undefined && !item.categoryIds.includes(category.id))
        .map((item) => item!.id);
      if (itemIds.length > 0) await bulkTagItems(client, showcaseId, itemIds, { addCategoryIds: [category.id] });
      categorySummaries.push({ name: category.name, id: category.id, created: category.created, tagged: itemIds.length });
    }
  } catch (error) {
    warnings.push(`Couldn't tag the videos: ${describeError(error)} Use tag_items to retry.`);
  }
  return { id: showcaseId, videosAdded, categories: categorySummaries };
}
