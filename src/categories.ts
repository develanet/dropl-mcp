import {
  GALLERY_CATEGORY_NAME_MAX_LENGTH,
  MAX_GALLERY_CATEGORIES,
  MAX_GALLERY_UPLOADS_PER_REQUEST,
  slugifyCategoryName,
  type BulkTagGalleryItemsRequest,
  type CreateGalleryCategoryRequest,
  type GalleryCategorySummary,
  type GalleryDetail,
} from "@dropl/shared";
import { pathSegment, type DroplApiClient } from "./api-client.js";
import { chunk } from "./concurrency.js";
import { DroplApiError, UserFacingError } from "./errors.js";
import { deriveIdempotencyKey } from "./idempotency.js";

const HTTP_CONFLICT = 409;
/** Items per bulk tag request; the API takes at most a request's worth of photos at once. */
export const TAG_BATCH_SIZE = MAX_GALLERY_UPLOADS_PER_REQUEST;

export interface CategoryRef {
  id: string;
  name: string;
  slug: string;
  created: boolean;
}

/** Trimmed, inner whitespace collapsed, cut to the API's limit. Null when nothing is left. */
export function normalizeCategoryName(name: string): string | null {
  const normalized = name.replace(/\s+/g, " ").trim().slice(0, GALLERY_CATEGORY_NAME_MAX_LENGTH).trim();
  return normalized || null;
}

export function categoryKey(name: string): string {
  return name.toLowerCase();
}

/** Same name (ignoring case) or the same slug counts as the same category. */
export function findCategory(categories: readonly GalleryCategorySummary[], name: string): GalleryCategorySummary | undefined {
  const wanted = categoryKey(name);
  const wantedSlug = slugifyCategoryName(name);
  return categories.find((category) => categoryKey(category.name) === wanted || category.slug === wantedSlug);
}

export function showcasePath(showcaseId: string): string {
  return `/v1/showcases/${pathSegment(showcaseId)}`;
}

/** Returns every requested category keyed by `categoryKey(name)`, creating the missing ones. */
export async function ensureCategories(
  client: DroplApiClient,
  showcaseId: string,
  names: readonly string[],
  existingCategories: readonly GalleryCategorySummary[],
): Promise<Map<string, CategoryRef>> {
  const resolved = new Map<string, CategoryRef>();
  const missing: string[] = [];
  for (const name of names) {
    const key = categoryKey(name);
    if (resolved.has(key) || missing.some((missingName) => categoryKey(missingName) === key)) continue;
    const existing = findCategory(existingCategories, name);
    if (existing) resolved.set(key, { id: existing.id, name: existing.name, slug: existing.slug, created: false });
    else missing.push(name);
  }
  if (existingCategories.length + missing.length > MAX_GALLERY_CATEGORIES) {
    throw new UserFacingError(
      `A showcase can have at most ${MAX_GALLERY_CATEGORIES} categories; it has ${existingCategories.length} and ${missing.length} more were requested. Use fewer categories (for example only top-level folders).`,
    );
  }

  for (const name of missing) {
    const body: CreateGalleryCategoryRequest = { name };
    try {
      const created = await client.post<GalleryCategorySummary>(`${showcasePath(showcaseId)}/categories`, body, {
        idempotencyKey: deriveIdempotencyKey("categories.create", showcaseId, body),
      });
      resolved.set(categoryKey(name), { id: created.id, name: created.name, slug: created.slug, created: true });
    } catch (error) {
      // Someone (or an earlier run) created it in the meantime: use theirs.
      if (!(error instanceof DroplApiError) || error.status !== HTTP_CONFLICT) throw error;
      const showcase = await client.get<GalleryDetail>(showcasePath(showcaseId));
      const existing = findCategory(showcase.categories, name);
      if (!existing) throw error;
      resolved.set(categoryKey(name), { id: existing.id, name: existing.name, slug: existing.slug, created: false });
    }
  }
  return resolved;
}

export async function bulkTagItems(
  client: DroplApiClient,
  showcaseId: string,
  itemIds: readonly string[],
  change: { addCategoryIds?: string[]; removeCategoryIds?: string[] },
): Promise<void> {
  for (const batch of chunk(itemIds, TAG_BATCH_SIZE)) {
    const body: BulkTagGalleryItemsRequest = { imageIds: batch, ...change };
    await client.post<unknown>(`${showcasePath(showcaseId)}/items/categories`, body);
  }
}
