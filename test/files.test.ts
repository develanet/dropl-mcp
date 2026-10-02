import { symlink } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectFiles } from "../src/files.js";
import { detectPhotoContentType, looksLikeVideo } from "../src/media.js";
import { AVIF_BYTES, HEIC_BYTES, JPEG_BYTES, PNG_BYTES, WEBP_BYTES, makeTempDirectory, mp4Bytes, removeDirectory, writeFiles } from "./helpers/fixtures.js";

describe("magic bytes", () => {
  it("detects each supported photo format", () => {
    expect(detectPhotoContentType(JPEG_BYTES, "image/jpeg")).toBe("image/jpeg");
    expect(detectPhotoContentType(PNG_BYTES, "image/png")).toBe("image/png");
    expect(detectPhotoContentType(WEBP_BYTES, "image/webp")).toBe("image/webp");
    expect(detectPhotoContentType(HEIC_BYTES, "image/heic")).toBe("image/heic");
    expect(detectPhotoContentType(HEIC_BYTES, "image/heif")).toBe("image/heif");
    expect(detectPhotoContentType(AVIF_BYTES, "image/avif")).toBe("image/avif");
  });

  it("uses the real format when the extension is wrong, and rejects non-images", () => {
    expect(detectPhotoContentType(PNG_BYTES, "image/jpeg")).toBe("image/png");
    expect(detectPhotoContentType(Buffer.from("<html>not a photo</html>"), "image/jpeg")).toBeNull();
    expect(detectPhotoContentType(mp4Bytes(64), "image/heic")).toBeNull();
  });

  it("recognises video containers", () => {
    expect(looksLikeVideo(mp4Bytes(64))).toBe(true);
    expect(looksLikeVideo(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0]))).toBe(true);
    expect(looksLikeVideo(Buffer.from("plain text"))).toBe(false);
  });
});

describe("collectFiles", () => {
  let root: string;
  beforeEach(async () => {
    root = await makeTempDirectory();
  });
  afterEach(() => removeDirectory(root));

  it("walks folders, skips hidden entries, records top folders, and sorts naturally", async () => {
    await writeFiles(root, {
      "shoot/img10.jpg": JPEG_BYTES,
      "shoot/img2.jpg": JPEG_BYTES,
      "shoot/Kitchens/a.jpg": JPEG_BYTES,
      "shoot/.DS_Store": "x",
      "shoot/.cache/b.jpg": JPEG_BYTES,
    });
    const result = await collectFiles(["shoot"], { cwd: root, recursive: true });
    expect(result.files.map((file) => file.relativePath)).toEqual(["img2.jpg", "img10.jpg", "Kitchens/a.jpg"]);
    expect(result.files.map((file) => file.topFolder)).toEqual([null, null, "Kitchens"]);
    expect(result.skipped.map((entry) => entry.reason).sort()).toEqual(["hidden", "hidden"]);
    expect(result.files[0]!.displayPath).toBe(path.join("shoot", "img2.jpg"));
  });

  it("honours recursive: false", async () => {
    await writeFiles(root, { "a.jpg": JPEG_BYTES, "sub/b.jpg": JPEG_BYTES });
    const result = await collectFiles([root], { cwd: "/", recursive: false });
    expect(result.files.map((file) => file.relativePath)).toEqual(["a.jpg"]);
  });

  it("expands globs relative to cwd", async () => {
    await writeFiles(root, { "p/a.jpg": JPEG_BYTES, "p/b.png": PNG_BYTES, "p/deep/c.jpg": JPEG_BYTES });
    const shallow = await collectFiles(["p/*.jpg"], { cwd: root, recursive: true });
    expect(shallow.files.map((file) => file.relativePath)).toEqual(["a.jpg"]);
    const deep = await collectFiles(["p/**/*.jpg"], { cwd: root, recursive: true });
    expect(deep.files.map((file) => file.relativePath)).toEqual(["a.jpg", "deep/c.jpg"]);
  });

  it("treats an existing folder with glob characters in its name as a path", async () => {
    await writeFiles(root, { "Shoot (2024)/a.jpg": JPEG_BYTES });
    const result = await collectFiles(["Shoot (2024)"], { cwd: root, recursive: true });
    expect(result.files).toHaveLength(1);
  });

  it.runIf(process.platform !== "win32")("follows symlinks inside the root, skips ones escaping it, and dedupes", async () => {
    const outside = await makeTempDirectory();
    try {
      await writeFiles(outside, { "secret.jpg": JPEG_BYTES });
      await writeFiles(root, { "photos/real.jpg": JPEG_BYTES });
      await symlink(path.join(outside, "secret.jpg"), path.join(root, "photos", "escape.jpg"));
      await symlink(path.join(root, "photos", "real.jpg"), path.join(root, "photos", "alias.jpg"));
      const result = await collectFiles(["photos", "photos/real.jpg"], { cwd: root, recursive: true });
      expect(result.files.map((file) => file.fileName)).toEqual(["alias.jpg"]);
      expect(result.duplicateCount).toBe(2);
      expect(result.skipped).toEqual([expect.objectContaining({ reason: "symlink_outside_root" })]);
    } finally {
      await removeDirectory(outside);
    }
  });

  it("reports missing paths and caps runaway walks", async () => {
    await writeFiles(root, { "a.jpg": JPEG_BYTES, "b.jpg": JPEG_BYTES, "c.jpg": JPEG_BYTES });
    const missing = await collectFiles(["nope"], { cwd: root, recursive: true });
    expect(missing.skipped[0]).toMatchObject({ reason: "not_found" });
    await expect(collectFiles(["."], { cwd: root, recursive: true, maxFiles: 2 })).rejects.toThrow(/narrower folder/);
  });

  it("gives the same fingerprint for an unchanged file and a new one after a change", async () => {
    await writeFiles(root, { "a.jpg": JPEG_BYTES });
    const first = await collectFiles(["a.jpg"], { cwd: root, recursive: true });
    const second = await collectFiles([path.join(root, "a.jpg")], { cwd: "/", recursive: true });
    expect(second.files[0]!.fingerprint).toBe(first.files[0]!.fingerprint);
    await writeFiles(root, { "a.jpg": Buffer.concat([JPEG_BYTES, Buffer.from("more")]) });
    const changed = await collectFiles(["a.jpg"], { cwd: root, recursive: true });
    expect(changed.files[0]!.fingerprint).not.toBe(first.files[0]!.fingerprint);
  });
});
