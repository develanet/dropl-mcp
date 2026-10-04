import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { isNodeError, writeFileAtomic } from "./fs-utils.js";

const MANIFEST_VERSION = 1;
const UPLOADS_DIRECTORY_NAME = "uploads";
/** Ids that are safe to use as a file name as is; anything else is hashed. */
const SAFE_FILE_NAME_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export type PhotoUploadStatus = "registered" | "uploaded" | "completed" | "failed";

export interface PhotoManifestEntry {
  path: string;
  imageId: string;
  status: PhotoUploadStatus;
  /** Projects showcases: the project the photo was uploaded into. */
  projectId?: string;
  updatedAt: string;
}

export type VideoUploadStatus = "uploading" | "completed";

export interface VideoManifestEntry {
  path: string;
  uploadSessionId: string;
  videoId: string;
  publicId: string;
  status: VideoUploadStatus;
  /** Bumped when a session can't be resumed, so the next create gets a fresh idempotency key. */
  generation: number;
  updatedAt: string;
}

interface ManifestDocument<Entry> {
  version: typeof MANIFEST_VERSION;
  apiUrl: string;
  /** The showcase (photos) or client site (videos) the files went to. */
  destinationId: string;
  /** Keyed by `LocalFile.fingerprint`. */
  files: Record<string, Entry>;
}

export function manifestPath(configDirectory: string, name: string): string {
  const safeName = SAFE_FILE_NAME_PATTERN.test(name) ? name : createHash("sha256").update(name).digest("hex");
  return path.join(configDirectory, UPLOADS_DIRECTORY_NAME, `${safeName}.json`);
}

export function photoManifestName(showcaseId: string): string {
  return showcaseId;
}

/**
 * Gallery uploads keep the bare fingerprint (what earlier versions wrote); a project's uploads are keyed by
 * project too, so the same file uploaded into two projects is two entries.
 */
export function photoManifestKey(fingerprint: string, projectId: string | null): string {
  return projectId === null ? fingerprint : createHash("sha256").update(`${projectId}\n${fingerprint}`).digest("hex");
}

export function videoManifestName(siteId: string): string {
  return `videos-${siteId}`;
}

/** Local record of what already reached Dropl, so a re-run after a crash skips or resumes instead of re-uploading. */
export class UploadManifest<Entry> {
  private constructor(
    private readonly filePath: string,
    private readonly document: ManifestDocument<Entry>,
  ) {}

  /** A missing, corrupt, or foreign (other API URL or destination) manifest starts empty. */
  static async load<Entry>(filePath: string, apiUrl: string, destinationId: string, warn: (message: string) => void): Promise<UploadManifest<Entry>> {
    const empty: ManifestDocument<Entry> = { version: MANIFEST_VERSION, apiUrl, destinationId, files: {} };
    try {
      const parsed = JSON.parse(await readFile(filePath, "utf8")) as Partial<ManifestDocument<Entry>> | null;
      const valid =
        parsed?.version === MANIFEST_VERSION &&
        parsed.apiUrl === apiUrl &&
        parsed.destinationId === destinationId &&
        typeof parsed.files === "object" &&
        parsed.files !== null;
      return new UploadManifest(filePath, valid ? (parsed as ManifestDocument<Entry>) : empty);
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) warn(`Ignoring unreadable upload manifest ${filePath}; files will be checked again.`);
      return new UploadManifest(filePath, empty);
    }
  }

  get(fingerprint: string): Entry | undefined {
    return this.document.files[fingerprint];
  }

  entries(): Entry[] {
    return Object.values(this.document.files);
  }

  set(fingerprint: string, entry: Entry): void {
    this.document.files[fingerprint] = entry;
  }

  delete(fingerprint: string): void {
    delete this.document.files[fingerprint];
  }

  async save(): Promise<void> {
    await writeFileAtomic(this.filePath, `${JSON.stringify(this.document)}\n`);
  }
}
