import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import picomatch from "picomatch";
import { UserFacingError } from "./errors.js";
import { isHiddenName, type RejectionReason } from "./media.js";

/** Stops a walk that was pointed at a home directory or drive root by mistake. */
export const DEFAULT_MAX_DISCOVERED_FILES = 20_000;

export interface LocalFile {
  /** Canonical path (symlinks resolved); what the fingerprint and dedupe use. */
  absolutePath: string;
  /** For messages: relative to the working directory when inside it. */
  displayPath: string;
  fileName: string;
  /** Relative to the folder (or glob base) it was found under, with `/` separators. */
  relativePath: string;
  /** First folder below that root, or null for files directly in it. */
  topFolder: string | null;
  sizeBytes: number;
  mtimeMs: number;
  /** Changes when the file is moved, resized, or modified, so the upload manifest never matches a different file. */
  fingerprint: string;
}

export interface SkippedPath {
  path: string;
  reason: RejectionReason;
  detail: string;
}

export interface CollectOptions {
  cwd: string;
  recursive: boolean;
  maxFiles?: number;
  homeDirectory?: string;
}

export interface CollectResult {
  files: LocalFile[];
  skipped: SkippedPath[];
  /** The same file reached through more than one input or link. */
  duplicateCount: number;
}

export function fileFingerprint(absolutePath: string, sizeBytes: number, mtimeMs: number): string {
  return createHash("sha256").update(`${absolutePath}\n${sizeBytes}\n${mtimeMs}`).digest("hex");
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function expandHome(input: string, homeDirectory: string): string {
  if (input === "~") return homeDirectory;
  if (input.startsWith("~/") || input.startsWith("~\\")) return path.join(homeDirectory, input.slice(2));
  return input;
}

const naturalOrder = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

export function compareFiles(left: LocalFile, right: LocalFile): number {
  return naturalOrder.compare(left.relativePath, right.relativePath) || (left.absolutePath < right.absolutePath ? -1 : 1);
}

class Collector {
  readonly files: LocalFile[] = [];
  readonly skipped: SkippedPath[] = [];
  duplicateCount = 0;
  private readonly seenFiles = new Set<string>();
  private readonly maxFiles: number;

  constructor(private readonly options: CollectOptions) {
    this.maxFiles = options.maxFiles ?? DEFAULT_MAX_DISCOVERED_FILES;
  }

  displayPath(logicalPath: string): string {
    return isInside(this.options.cwd, logicalPath) ? path.relative(this.options.cwd, logicalPath) || "." : logicalPath;
  }

  skip(logicalPath: string, reason: RejectionReason, detail: string): void {
    this.skipped.push({ path: this.displayPath(logicalPath), reason, detail });
  }

  addFile(realFilePath: string, logicalPath: string, relativePath: string, stats: Stats): void {
    if (this.seenFiles.has(realFilePath)) {
      this.duplicateCount += 1;
      return;
    }
    if (this.seenFiles.size >= this.maxFiles) {
      throw new UserFacingError(
        `Found more than ${this.maxFiles} files. Point at a narrower folder (for example one project's photo folder, not a home directory).`,
      );
    }
    this.seenFiles.add(realFilePath);
    const segments = relativePath.split("/");
    this.files.push({
      absolutePath: realFilePath,
      displayPath: this.displayPath(logicalPath),
      fileName: path.basename(logicalPath),
      relativePath,
      topFolder: segments.length > 1 ? segments[0]! : null,
      sizeBytes: stats.size,
      mtimeMs: stats.mtimeMs,
      fingerprint: fileFingerprint(realFilePath, stats.size, stats.mtimeMs),
    });
  }

  /**
   * Hidden entries are skipped. Symlinks are followed only while they stay inside `realRoot`,
   * and each real directory is walked once, so link loops end.
   */
  async walk(
    realDirectory: string,
    logicalDirectory: string,
    realRoot: string,
    relativePrefix: string,
    recursive: boolean,
    matcher: ((relativePath: string) => boolean) | null,
    visitedDirectories: Set<string>,
  ): Promise<void> {
    let entries;
    try {
      entries = await readdir(realDirectory, { withFileTypes: true });
    } catch {
      this.skip(logicalDirectory, "unreadable", "couldn't list the folder");
      return;
    }
    entries.sort((left, right) => naturalOrder.compare(left.name, right.name));

    for (const entry of entries) {
      const logicalPath = path.join(logicalDirectory, entry.name);
      const relativePath = relativePrefix ? `${relativePrefix}/${entry.name}` : entry.name;
      if (isHiddenName(entry.name)) {
        this.skip(logicalPath, "hidden", entry.isDirectory() ? "hidden folder" : "hidden file");
        continue;
      }

      let realEntryPath = path.join(realDirectory, entry.name);
      let stats: Stats;
      try {
        if (entry.isSymbolicLink()) {
          realEntryPath = await realpath(realEntryPath);
          if (!isInside(realRoot, realEntryPath)) {
            this.skip(logicalPath, "symlink_outside_root", "links outside the folder being uploaded");
            continue;
          }
        }
        stats = await stat(realEntryPath);
      } catch {
        this.skip(logicalPath, "not_found", "broken link or file removed while scanning");
        continue;
      }

      if (stats.isDirectory()) {
        if (!recursive || visitedDirectories.has(realEntryPath)) continue;
        visitedDirectories.add(realEntryPath);
        await this.walk(realEntryPath, logicalPath, realRoot, relativePath, recursive, matcher, visitedDirectories);
      } else if (stats.isFile()) {
        if (matcher && !matcher(relativePath)) continue;
        this.addFile(realEntryPath, logicalPath, relativePath, stats);
      }
    }
  }

  async collectGlob(pattern: string): Promise<void> {
    const scan = picomatch.scan(pattern);
    const logicalBase = path.resolve(this.options.cwd, scan.base || ".");
    let realBase: string;
    try {
      realBase = await realpath(logicalBase);
    } catch {
      this.skip(logicalBase, "not_found", `no folder for the pattern ${pattern}`);
      return;
    }
    const matcher = picomatch(scan.glob, { dot: false });
    const crossesFolders = scan.glob.includes("/") || scan.glob.includes("**");
    await this.walk(realBase, logicalBase, realBase, "", crossesFolders, matcher, new Set([realBase]));
  }

  async collectPath(input: string): Promise<void> {
    const logicalPath = path.resolve(this.options.cwd, input);
    let realTarget: string;
    let stats: Stats;
    try {
      realTarget = await realpath(logicalPath);
      stats = await stat(realTarget);
    } catch {
      this.skip(logicalPath, "not_found", "no such file or folder");
      return;
    }
    if (stats.isDirectory()) {
      await this.walk(realTarget, logicalPath, realTarget, "", this.options.recursive, null, new Set([realTarget]));
    } else if (stats.isFile()) {
      // A file named explicitly is taken even if hidden: the user asked for it.
      this.addFile(realTarget, logicalPath, path.basename(logicalPath), stats);
    } else {
      this.skip(logicalPath, "unsupported_type", "not a regular file or folder");
    }
  }
}

/** Resolves files, folders, and globs (relative to `cwd`) into a sorted, de-duplicated file list. */
export async function collectFiles(inputs: readonly string[], options: CollectOptions): Promise<CollectResult> {
  const collector = new Collector(options);
  const homeDirectory = options.homeDirectory ?? homedir();
  for (const rawInput of inputs) {
    const trimmed = rawInput.trim();
    if (!trimmed) continue;
    const input = expandHome(trimmed, homeDirectory);
    const globInput = process.platform === "win32" ? input.replace(/\\/g, "/") : input;
    // Folder names like `Shoot (2024)` look like globs; an existing path always wins.
    const isLiteralPath = await stat(path.resolve(options.cwd, input)).then(
      () => true,
      () => false,
    );
    if (!isLiteralPath && picomatch.scan(globInput).isGlob) await collector.collectGlob(globInput);
    else await collector.collectPath(input);
  }
  collector.files.sort(compareFiles);
  return { files: collector.files, skipped: collector.skipped, duplicateCount: collector.duplicateCount };
}
