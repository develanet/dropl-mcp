import {
  MAX_GALLERY_ITEMS_PER_UPDATE,
  normalizeAltText,
  type BulkUpdateGalleryItemsRequest,
  type BulkUpdateGalleryItemsResponse,
  type GalleryCategorySummary,
  type GalleryDetail,
  type GalleryImageSummary,
} from "@dropl/shared";
import type { DroplApiClient } from "./api-client.js";
import { categoryKey, ensureCategories, findCategory, normalizeCategoryName, showcasePath } from "./categories.js";
import { chunk } from "./concurrency.js";
import { describeError, UserFacingError } from "./errors.js";
import { truncateList } from "./format.js";
import { UploadManifest, manifestPath, photoManifestName, videoManifestName, type PhotoManifestEntry, type VideoManifestEntry } from "./manifest.js";

export const LIST_ITEMS_DEFAULT_LIMIT = 50;
export const LIST_ITEMS_MAX_LIMIT = 200;
const MAX_LISTED_UNKNOWN_IDS = 10;
const MAX_LISTED_UPDATED_ITEMS = 50;

export interface ShowcaseItemView {
  id: string;
  kind: GalleryImageSummary["kind"];
  status: GalleryImageSummary["status"];
  fileName: string | null;
  /** Where this MCP server uploaded it from, when it did. */
  localPath?: string;
  alt: string | null;
  categories: string[];
  videoId?: string;
  failureReason?: string;
}

export interface ListItemsFilters {
  kind?: "photo" | "video";
  missingAlt?: boolean;
  category?: string;
  search?: string;
  offset?: number;
  limit?: number;
}

/** Item ids pass through; library video ids (what upload_videos returns) become their showcase item ids. */
export function resolveItemIds(detail: GalleryDetail, ids: readonly string[]): string[] {
  const itemIds = new Set(detail.images.map((item) => item.id));
  const itemIdByVideoId = new Map(detail.images.flatMap((item) => (item.video ? [[item.video.id, item.id] as const] : [])));
  const unknown: string[] = [];
  const resolved = ids.map((id) => {
    if (itemIds.has(id)) return id;
    const itemId = itemIdByVideoId.get(id);
    if (!itemId) unknown.push(id);
    return itemId ?? id;
  });
  if (unknown.length > 0) {
    const listed = truncateList(unknown, MAX_LISTED_UNKNOWN_IDS);
    const more = listed.omitted > 0 ? ` and ${listed.omitted} more` : "";
    throw new UserFacingError(
      `Not in showcase "${detail.title}": ${listed.items.join(", ")}${more}. Use ids from upload_photos, upload_videos, or list_showcase_items.`,
    );
  }
  return resolved;
}

/** A category by id, slug, or name (ignoring case). */
export function matchCategory(categories: readonly GalleryCategorySummary[], reference: string): GalleryCategorySummary | undefined {
  const trimmed = reference.trim();
  const byIdOrSlug = categories.find((category) => category.id === trimmed || category.slug === trimmed);
  if (byIdOrSlug) return byIdOrSlug;
  const name = normalizeCategoryName(trimmed);
  return name ? findCategory(categories, name) : undefined;
}

/** Local paths from this machine's upload manifests (photos of the showcase, videos of its site), keyed by item id. */
export async function localPathsByItemId(
  client: DroplApiClient,
  configDirectory: string,
  detail: GalleryDetail,
  warn: (message: string) => void,
): Promise<Map<string, string>> {
  const [photos, videos] = await Promise.all([
    UploadManifest.load<PhotoManifestEntry>(manifestPath(configDirectory, photoManifestName(detail.id)), client.apiUrl, detail.id, warn),
    UploadManifest.load<VideoManifestEntry>(manifestPath(configDirectory, videoManifestName(detail.workspaceId)), client.apiUrl, detail.workspaceId, warn),
  ]);
  const pathByImageId = new Map(photos.entries().map((entry) => [entry.imageId, entry.path]));
  const pathByVideoId = new Map(videos.entries().map((entry) => [entry.videoId, entry.path]));
  const paths = new Map<string, string>();
  for (const item of detail.images) {
    const localPath = item.video ? pathByVideoId.get(item.video.id) : pathByImageId.get(item.id);
    if (localPath) paths.set(item.id, localPath);
  }
  return paths;
}

function itemView(item: GalleryImageSummary, categoryNames: Map<string, string>, localPath: string | undefined): ShowcaseItemView {
  return {
    id: item.id,
    kind: item.kind,
    status: item.status,
    fileName: item.video?.title ?? item.sourceFileName,
    ...(localPath && { localPath }),
    alt: item.altText,
    categories: item.categoryIds.flatMap((id) => categoryNames.get(id) ?? []),
    ...(item.video && { videoId: item.video.id }),
    ...(item.failureReason && { failureReason: item.failureReason }),
  };
}

export function listItemsResult(detail: GalleryDetail, localPaths: Map<string, string>, filters: ListItemsFilters) {
  const categoryNames = new Map(detail.categories.map((category) => [category.id, category.name]));
  let category: GalleryCategorySummary | undefined;
  if (filters.category) {
    category = matchCategory(detail.categories, filters.category);
    if (!category) throw new UserFacingError(`No category "${filters.category}" in this showcase. Its categories: ${detail.categories.map((entry) => entry.name).join(", ") || "none"}.`);
  }
  const search = filters.search?.trim().toLowerCase();
  const matching = detail.images.filter((item) => {
    if (filters.kind && item.kind !== filters.kind) return false;
    if (filters.missingAlt && (item.kind !== "photo" || item.altText)) return false;
    if (category && !item.categoryIds.includes(category.id)) return false;
    if (!search) return true;
    const haystack = [item.sourceFileName, item.altText, item.video?.title, localPaths.get(item.id)].filter(Boolean).join("\n").toLowerCase();
    return haystack.includes(search);
  });
  const offset = filters.offset ?? 0;
  const limit = filters.limit ?? LIST_ITEMS_DEFAULT_LIMIT;
  const page = matching.slice(offset, offset + limit);
  return {
    showcaseId: detail.id,
    title: detail.title,
    total: matching.length,
    offset,
    nextOffset: offset + page.length < matching.length ? offset + page.length : null,
    photosWithoutAltText: detail.images.filter((item) => item.kind === "photo" && !item.altText).length,
    categories: detail.categories.map((entry) => ({ id: entry.id, name: entry.name, slug: entry.slug })),
    items: page.map((item) => itemView(item, categoryNames, localPaths.get(item.id))),
  };
}

export interface ItemUpdateInput {
  id: string;
  alt?: string | null;
  addCategories?: string[];
  removeCategories?: string[];
}

interface MergedChange {
  altText?: string | null;
  add: Set<string>;
  remove: Set<string>;
}

/** Same item listed twice: the later alt text wins, categories add up. */
function mergeChanges(detail: GalleryDetail, updates: readonly ItemUpdateInput[]): Map<string, MergedChange> {
  const itemIds = resolveItemIds(detail, updates.map((update) => update.id));
  const merged = new Map<string, MergedChange>();
  updates.forEach((update, index) => {
    const itemId = itemIds[index]!;
    const change = merged.get(itemId) ?? { add: new Set<string>(), remove: new Set<string>() };
    if (update.alt !== undefined) change.altText = normalizeAltText(update.alt);
    for (const reference of update.addCategories ?? []) change.add.add(reference);
    for (const reference of update.removeCategories ?? []) change.remove.add(reference);
    merged.set(itemId, change);
  });
  return merged;
}

export async function updateShowcaseItems(client: DroplApiClient, showcaseId: string, updates: readonly ItemUpdateInput[]) {
  const detail = await client.get<GalleryDetail>(showcasePath(showcaseId));
  const merged = mergeChanges(detail, updates);
  const warnings: string[] = [];

  const namesToCreate = [...merged.values()]
    .flatMap((change) => [...change.add])
    .filter((reference) => !matchCategory(detail.categories, reference))
    .flatMap((reference) => normalizeCategoryName(reference) ?? []);
  const created = namesToCreate.length > 0 ? await ensureCategories(client, showcaseId, namesToCreate, detail.categories) : new Map();
  const resolveAdd = (reference: string) =>
    matchCategory(detail.categories, reference)?.id ?? created.get(categoryKey(normalizeCategoryName(reference) ?? reference))?.id;
  const unknownRemovals = new Set<string>();
  const resolveRemove = (reference: string) => {
    const id = matchCategory(detail.categories, reference)?.id;
    if (!id) unknownRemovals.add(reference);
    return id;
  };

  const itemsById = new Map(detail.images.map((item) => [item.id, item]));
  const changes: BulkUpdateGalleryItemsRequest["items"] = [];
  let unchanged = 0;
  for (const [itemId, change] of merged) {
    const item = itemsById.get(itemId)!;
    const addCategoryIds = [...new Set([...change.add].flatMap((reference) => resolveAdd(reference) ?? []))].filter((id) => !item.categoryIds.includes(id));
    const removeCategoryIds = [...new Set([...change.remove].flatMap((reference) => resolveRemove(reference) ?? []))].filter((id) => item.categoryIds.includes(id));
    const clash = addCategoryIds.find((id) => removeCategoryIds.includes(id));
    if (clash) throw new UserFacingError(`Item ${itemId} can't have category "${detail.categories.find((category) => category.id === clash)?.name ?? clash}" added and removed at once.`);
    const altChanged = change.altText !== undefined && change.altText !== item.altText;
    if (!altChanged && addCategoryIds.length === 0 && removeCategoryIds.length === 0) {
      unchanged += 1;
      continue;
    }
    changes.push({
      id: itemId,
      ...(altChanged && { altText: change.altText }),
      ...(addCategoryIds.length > 0 && { addCategoryIds }),
      ...(removeCategoryIds.length > 0 && { removeCategoryIds }),
    });
  }

  for (const reference of unknownRemovals) warnings.push(`No category "${reference}" to remove; skipped.`);

  const updated: GalleryImageSummary[] = [];
  let failedCount = 0;
  for (const batch of chunk(changes, MAX_GALLERY_ITEMS_PER_UPDATE)) {
    try {
      const response = await client.request<BulkUpdateGalleryItemsResponse>("PATCH", `${showcasePath(showcaseId)}/items`, { body: { items: batch } });
      updated.push(...response.data.items);
    } catch (error) {
      failedCount += batch.length;
      warnings.push(`Couldn't update ${batch.length} items: ${describeError(error)} Nothing in that batch changed; retry update_items with them.`);
    }
  }

  const updatedIds = new Set(updated.map((item) => item.id));
  const applied = changes.filter((change) => updatedIds.has(change.id));
  const categoryNames = new Map([...detail.categories.map((category) => [category.id, category.name] as const), ...[...created.values()].map((category) => [category.id, category.name] as const)]);
  const listed = truncateList(updated.map((item) => ({ id: item.id, alt: item.altText, categories: item.categoryIds.flatMap((id) => categoryNames.get(id) ?? []) })), MAX_LISTED_UPDATED_ITEMS);
  return {
    showcaseId,
    updated: updated.length,
    unchanged,
    failed: failedCount,
    altTextSet: applied.filter((change) => change.altText).length,
    altTextCleared: applied.filter((change) => change.altText === null).length,
    createdCategories: [...created.values()].filter((category) => category.created).map((category) => category.name),
    items: listed.items,
    itemsOmitted: listed.omitted,
    warnings,
  };
}
