import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DroplApiClient } from "../../src/api-client.js";
import { putToStorage } from "../../src/storage-put.js";
import type { MediaUploadContext } from "../../src/upload-common.js";
import { TEST_API_KEY, type MockDroplApi } from "./mock-api.js";

const PADDING_BYTES = 32;

export const JPEG_BYTES = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(PADDING_BYTES, 1)]);
export const PNG_BYTES = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(PADDING_BYTES, 2)]);
export const WEBP_BYTES = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0x24, 0, 0, 0]), Buffer.from("WEBPVP8 "), Buffer.alloc(PADDING_BYTES, 3)]);
export const HEIC_BYTES = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypheic"), Buffer.from([0, 0, 0, 0]), Buffer.from("mif1heic"), Buffer.alloc(PADDING_BYTES, 4)]);
export const AVIF_BYTES = Buffer.concat([Buffer.from([0, 0, 0, 0x1c]), Buffer.from("ftypavif"), Buffer.from([0, 0, 0, 0]), Buffer.from("avifmif1miaf"), Buffer.alloc(PADDING_BYTES, 5)]);

export function mp4Bytes(sizeBytes: number): Buffer {
  const header = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom"), Buffer.from([0, 0, 2, 0]), Buffer.from("isomiso2")]);
  const body = Buffer.alloc(Math.max(0, sizeBytes - header.length));
  for (let index = 0; index < body.length; index += 1) body[index] = index % 251;
  return Buffer.concat([header, body]).subarray(0, sizeBytes);
}

export async function makeTempDirectory(prefix = "dropl-mcp-test-"): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

export async function removeDirectory(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true });
}

export async function writeFiles(root: string, files: Record<string, Buffer | string>): Promise<void> {
  for (const [relativePath, contents] of Object.entries(files)) {
    const filePath = path.join(root, relativePath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, contents);
  }
}

/** Distinct bytes per file, so files never look identical. */
export function uniqueJpeg(index: number): Buffer {
  return Buffer.concat([JPEG_BYTES, Buffer.from(`photo-${index}`)]);
}

export interface TestUploadContext extends MediaUploadContext {
  sleeps: number[];
  warnings: string[];
}

export function uploadContextFor(api: MockDroplApi, configDirectory: string, overrides: Partial<MediaUploadContext> = {}): TestUploadContext {
  const sleeps: number[] = [];
  const warnings: string[] = [];
  const sleep = async (milliseconds: number) => {
    sleeps.push(milliseconds);
  };
  return {
    client: new DroplApiClient({ apiUrl: api.baseUrl, apiKey: TEST_API_KEY, sleep, random: () => 0.5 }),
    configDirectory,
    putFile: putToStorage,
    sleep,
    random: () => 0.5,
    now: Date.now,
    warn: (message) => warnings.push(message),
    sleeps,
    warnings,
    ...overrides,
  };
}
