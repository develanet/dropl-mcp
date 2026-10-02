import { randomBytes } from "node:crypto";
import { chmod, mkdir, open, rename, rm } from "node:fs/promises";
import path from "node:path";

export const PRIVATE_DIRECTORY_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;
/** Any group or other permission bit. */
export const GROUP_OR_WORLD_ACCESS_MASK = 0o077;
const TEMP_SUFFIX_BYTES = 6;

export async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  if (process.platform !== "win32") {
    // mkdir leaves an existing directory's mode alone.
    await chmod(directory, PRIVATE_DIRECTORY_MODE).catch(() => undefined);
  }
}

/** Temp file in the same directory, then rename, so readers never see a half-written file. */
export async function writeFileAtomic(filePath: string, contents: string, mode: number = PRIVATE_FILE_MODE): Promise<void> {
  await ensurePrivateDirectory(path.dirname(filePath));
  const tempPath = `${filePath}.${process.pid}.${randomBytes(TEMP_SUFFIX_BYTES).toString("hex")}.tmp`;
  try {
    const handle = await open(tempPath, "wx", mode);
    try {
      await handle.writeFile(contents, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}
