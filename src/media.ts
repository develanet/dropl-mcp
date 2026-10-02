import { open } from "node:fs/promises";
import path from "node:path";
import {
  MAX_GALLERY_IMAGE_SIZE_BYTES,
  MAX_UPLOAD_SIZE_BYTES,
  type GalleryImageContentType,
  type UploadContentType,
} from "@dropl/shared";
import { formatBytes } from "./format.js";

export type MediaKind = "photo" | "video";

export type RejectionReason =
  | "hidden"
  | "unsupported_type"
  | "too_large"
  | "empty"
  | "invalid_content"
  | "symlink_outside_root"
  | "not_found"
  | "unreadable";

export const REJECTION_REASON_LABELS: Record<RejectionReason, string> = {
  hidden: "hidden file or folder",
  unsupported_type: "unsupported file type",
  too_large: "too large",
  empty: "empty file",
  invalid_content: "contents don't match a supported format",
  symlink_outside_root: "symlink pointing outside the folder",
  not_found: "not found",
  unreadable: "couldn't be read",
};

export const PHOTO_CONTENT_TYPES_BY_EXTENSION: Readonly<Record<string, GalleryImageContentType>> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  avif: "image/avif",
  heic: "image/heic",
  heif: "image/heif",
};

export const VIDEO_CONTENT_TYPES_BY_EXTENSION: Readonly<Record<string, UploadContentType>> = {
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  mkv: "video/x-matroska",
  avi: "video/x-msvideo",
  mpeg: "video/mpeg",
  mpg: "video/mpeg",
  m4v: "video/x-m4v",
};

/** Enough for the ISO-BMFF `ftyp` box with a handful of compatible brands. */
export const FILE_HEADER_LENGTH = 64;
const FTYP_BOX_TYPE_OFFSET = 4;
const FTYP_MAJOR_BRAND_OFFSET = 8;
const FTYP_COMPATIBLE_BRANDS_OFFSET = 16;
const BRAND_LENGTH = 4;
const RIFF_FORM_TYPE_OFFSET = 8;

const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const EBML_SIGNATURE = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);
const MPEG_PACK_START = Buffer.from([0x00, 0x00, 0x01, 0xba]);
const MPEG_SEQUENCE_START = Buffer.from([0x00, 0x00, 0x01, 0xb3]);
const MPEG_TRANSPORT_SYNC_BYTE = 0x47;
const AVIF_BRANDS = new Set(["avif", "avis"]);
const HEIC_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis"]);
/** Generic HEIF image brands that both HEIC and AVIF files may carry. */
const GENERIC_HEIF_BRANDS = new Set(["mif1", "msf1"]);
/** Top-level atoms older QuickTime files start with instead of `ftyp`. */
const QUICKTIME_LEADING_ATOMS = new Set(["moov", "mdat", "wide", "free", "skip", "pnot"]);

export function fileExtension(fileName: string): string {
  return path.extname(fileName).slice(1).toLowerCase();
}

export function isHiddenName(name: string): boolean {
  return name.startsWith(".");
}

export function mediaKindOf(fileName: string): MediaKind | null {
  const extension = fileExtension(fileName);
  if (extension in PHOTO_CONTENT_TYPES_BY_EXTENSION) return "photo";
  if (extension in VIDEO_CONTENT_TYPES_BY_EXTENSION) return "video";
  return null;
}

function startsWith(header: Buffer, signature: Buffer, offset = 0): boolean {
  return header.length >= offset + signature.length && header.subarray(offset, offset + signature.length).equals(signature);
}

function asciiAt(header: Buffer, offset: number, length: number): string {
  return header.length >= offset + length ? header.toString("latin1", offset, offset + length) : "";
}

/** Major and compatible brands of an ISO-BMFF `ftyp` box, or null when there isn't one. */
export function ftypBrands(header: Buffer): Set<string> | null {
  if (asciiAt(header, FTYP_BOX_TYPE_OFFSET, BRAND_LENGTH) !== "ftyp") return null;
  const boxSize = header.readUInt32BE(0);
  const brands = new Set([asciiAt(header, FTYP_MAJOR_BRAND_OFFSET, BRAND_LENGTH)]);
  const end = Math.min(boxSize, header.length);
  for (let offset = FTYP_COMPATIBLE_BRANDS_OFFSET; offset + BRAND_LENGTH <= end; offset += BRAND_LENGTH) {
    brands.add(asciiAt(header, offset, BRAND_LENGTH));
  }
  return brands;
}

/**
 * The photo's real format from its first bytes. Generic HEIF brands can't tell HEIC from AVIF,
 * so the extension decides then. Null when the bytes aren't a supported photo.
 */
export function detectPhotoContentType(header: Buffer, extensionType: GalleryImageContentType): GalleryImageContentType | null {
  if (startsWith(header, JPEG_SIGNATURE)) return "image/jpeg";
  if (startsWith(header, PNG_SIGNATURE)) return "image/png";
  if (asciiAt(header, 0, 4) === "RIFF" && asciiAt(header, RIFF_FORM_TYPE_OFFSET, 4) === "WEBP") return "image/webp";
  const brands = ftypBrands(header);
  if (!brands) return null;
  if ([...brands].some((brand) => AVIF_BRANDS.has(brand))) return "image/avif";
  if ([...brands].some((brand) => HEIC_BRANDS.has(brand))) return extensionType === "image/heif" ? "image/heif" : "image/heic";
  if ([...brands].some((brand) => GENERIC_HEIF_BRANDS.has(brand))) {
    return extensionType === "image/avif" || extensionType === "image/heif" ? extensionType : "image/heic";
  }
  return null;
}

/** Any recognised video container; the transcoder handles a container that doesn't match its extension. */
export function looksLikeVideo(header: Buffer): boolean {
  if (ftypBrands(header)) return true;
  if (QUICKTIME_LEADING_ATOMS.has(asciiAt(header, FTYP_BOX_TYPE_OFFSET, BRAND_LENGTH))) return true;
  if (startsWith(header, EBML_SIGNATURE)) return true;
  if (asciiAt(header, 0, 4) === "RIFF" && asciiAt(header, RIFF_FORM_TYPE_OFFSET, 3) === "AVI") return true;
  if (startsWith(header, MPEG_PACK_START) || startsWith(header, MPEG_SEQUENCE_START)) return true;
  return header[0] === MPEG_TRANSPORT_SYNC_BYTE;
}

export async function readFileHeader(filePath: string, length: number = FILE_HEADER_LENGTH): Promise<Buffer> {
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

export type Classification<ContentType> =
  | { accepted: true; contentType: ContentType }
  | { accepted: false; reason: RejectionReason; detail: string };

function sizeRejection(sizeBytes: number, maxBytes: number): Classification<never> | null {
  if (sizeBytes === 0) return { accepted: false, reason: "empty", detail: "the file is empty" };
  if (sizeBytes > maxBytes) {
    return { accepted: false, reason: "too_large", detail: `${formatBytes(sizeBytes)}, over the ${formatBytes(maxBytes)} limit` };
  }
  return null;
}

export async function classifyPhoto(filePath: string, sizeBytes: number): Promise<Classification<GalleryImageContentType>> {
  const extensionType = PHOTO_CONTENT_TYPES_BY_EXTENSION[fileExtension(filePath)];
  if (!extensionType) return { accepted: false, reason: "unsupported_type", detail: "not a JPEG, PNG, WebP, AVIF or HEIC photo" };
  const rejection = sizeRejection(sizeBytes, MAX_GALLERY_IMAGE_SIZE_BYTES);
  if (rejection) return rejection;
  let header: Buffer;
  try {
    header = await readFileHeader(filePath);
  } catch {
    return { accepted: false, reason: "unreadable", detail: "couldn't read the file" };
  }
  const contentType = detectPhotoContentType(header, extensionType);
  if (!contentType) return { accepted: false, reason: "invalid_content", detail: "not a valid JPEG, PNG, WebP, AVIF or HEIC file" };
  return { accepted: true, contentType };
}

export async function classifyVideo(filePath: string, sizeBytes: number): Promise<Classification<UploadContentType>> {
  const contentType = VIDEO_CONTENT_TYPES_BY_EXTENSION[fileExtension(filePath)];
  if (!contentType) return { accepted: false, reason: "unsupported_type", detail: "not a supported video type" };
  const rejection = sizeRejection(sizeBytes, MAX_UPLOAD_SIZE_BYTES);
  if (rejection) return rejection;
  let header: Buffer;
  try {
    header = await readFileHeader(filePath);
  } catch {
    return { accepted: false, reason: "unreadable", detail: "couldn't read the file" };
  }
  if (!looksLikeVideo(header)) return { accepted: false, reason: "invalid_content", detail: "not a recognisable video file" };
  return { accepted: true, contentType };
}
