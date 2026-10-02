import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { CallToolResult, ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  COLLECTION_EDIT_RULES,
  COLLECTION_TOOL_DESCRIPTIONS,
  CollectionToolError,
  GALLERY_CATEGORY_NAME_MAX_LENGTH,
  GALLERY_CATEGORY_SLUG_MAX_LENGTH,
  GALLERY_CATEGORY_SLUG_PATTERN,
  GALLERY_LIST_MAX_LIMIT,
  GALLERY_PAGE_SIZE_MAX,
  GALLERY_PAGE_SIZE_MIN,
  GALLERY_TITLE_MAX_LENGTH,
  MAX_GALLERY_VIDEOS_PER_REQUEST,
  SITE_DOMAIN_MAX_LENGTH,
  SITE_DOMAIN_PATTERN,
  VIDEO_LIST_MAX_LIMIT,
  WORKSPACE_NAME_MAX_LENGTH,
  COLLECTION_ITEMS_PAGE_MAX,
  FEEDBACK_LIST_PAGE_MAX,
  FEEDBACK_MESSAGE_MAX_LENGTH,
  FEEDBACK_REQUEST_TYPES,
  FEEDBACK_RESOLUTION_NOTE_MAX_LENGTH,
  FEEDBACK_STATUSES,
  type AddGalleryVideosRequest,
  type CollectionActivityResponse,
  type CollectionItemListResponse,
  type CollectionListResponse,
  type CollectionPlanResponse,
  type CollectionSchemaChangeResponse,
  type CollectionSchemaResponse,
  type CreateGalleryCategoryRequest,
  type FeedbackMessageSummary,
  type FeedbackRequestDetail,
  type GalleryCategorySummary,
  type GalleryDetail,
  type GalleryListResponse,
  type PublicApiCreateShowcaseRequest,
  type PublicApiCreateSiteRequest,
  type PublicApiMeResponse,
  type PublicApiShowcaseEmbedResponse,
  type PublicApiSite,
  type PublicApiSitesResponse,
  type PublicApiVideoEmbedResponse,
  type PublicFeedbackListResponse,
  type UpdateGalleryRequest,
  type UsageSummaryResponse,
  type VideoListResponse,
} from "@dropl/shared";
import { DroplApiClient, pathSegment } from "./api-client.js";
import { bulkTagItems, ensureCategories, findCategory, normalizeCategoryName, showcasePath } from "./categories.js";
import {
  addCollectionItems,
  collectionCodeResult,
  collectionItemFiltersSchema,
  collectionItemInputSchema,
  collectionListResult,
  collectionPath,
  collectionPlanSchema,
  itemFilterQuery,
  itemListResult,
  MAX_COLLECTION_ITEMS_PER_CALL,
  pickUndoableActivity,
  planResult,
  sitePath,
} from "./collections.js";
import { chunk } from "./concurrency.js";
import { ConfigError, configDirectory, currentPlatformContext, LOGIN_COMMAND, resolveApiUrl, type PlatformContext } from "./config.js";
import { CredentialsError, credentialsPath, resolveCredentials, type ResolvedCredentials } from "./credentials.js";
import { showcaseEmbedResult, videoEmbedResult } from "./embed.js";
import { describeError, UserFacingError } from "./errors.js";
import { FEEDBACK_TOOL_GUIDANCE, feedbackDetailResult, feedbackListResult, feedbackPath } from "./feedback.js";
import { formatBytes, truncateList } from "./format.js";
import { deriveIdempotencyKey } from "./idempotency.js";
import { planMigration } from "./migration-plan.js";
import { uploadPhotos } from "./photo-upload.js";
import { sleep as defaultSleep, type Random, type Sleep } from "./retry.js";
import { putToStorage, type StoragePut } from "./storage-put.js";
import type { MediaUploadContext, ProgressReporter } from "./upload-common.js";
import { PACKAGE_VERSION } from "./version.js";
import { uploadVideos } from "./video-upload.js";

const SERVER_NAME = "dropl";
const MAX_LISTED_FAILED_ITEMS = 10;
/** Progress notifications are throttled so a big upload doesn't flood the client. */
const PROGRESS_MIN_INTERVAL_MS = 250;
const ID_MAX_LENGTH = 200;
const PATH_MAX_LENGTH = 4096;
const MAX_PATHS_PER_CALL = 1000;
const MAX_ITEM_IDS_PER_CALL = 1000;
const MAX_CATEGORIES_PER_CALL = 50;
const PERCENT = 100;
/** plan_migration works offline, so its optional storage lookup must not hold it up. */
const USAGE_PROBE_TIMEOUT_MS = 5_000;

export const SERVER_INSTRUCTIONS = `Dropl hosts photo/video showcases and videos that web studios embed on their clients' websites. These tools create client sites and showcases in the user's Dropl account, upload local photos and videos, and return embed code.

Rules:
- Before creating a site or showcase or uploading anything, run plan_migration (or upload_photos / upload_videos with dryRun: true), show the plan to the user (client site, showcase title, categories, file counts and sizes) and get their explicit confirmation. Don't create or upload on your own initiative.
- Prefer existing client sites and showcases (list_sites, list_showcases) over creating duplicates.
- Never ask the user to paste an API key into the chat. If a tool says you're not signed in, ask the user to run \`${LOGIN_COMMAND}\` in their own terminal (or set DROPL_API_KEY in this server's MCP config), then try again.
- Pass absolute paths (or set cwd to the project folder) for uploads.
- Uploads are resumable and idempotent: if one stops partway, run the same call again; finished files are skipped.
- Use get_embed_code for embed snippets; never write embed HTML by hand.
- After adding an embed to the user's project, run the project's build (or type check) to make sure it still compiles.

Collections (structured content like menus, inventory, and events that clients edit in the dashboard):
- ${COLLECTION_EDIT_RULES.readFirst}
- Run plan_collections first (it never saves), show the summary to the user, and only call apply_collection_plan after their explicit confirmation. Pass confirmDestructive: true only after they agree to every change marked destructive.
- ${COLLECTION_EDIT_RULES.keepKeys}
- Import items with add_collection_items and dryRun: true first; fix or report per-item errors before saving.
- ${COLLECTION_EDIT_RULES.useCode}

Feedback (requests clients leave on their website). To fix the open Dropl feedback:
1. list_sites to find the site, then list_feedback (open and in progress by default).
2. get_feedback for each request: page, element selector and nearby text, device, screenshot, and the thread.
3. ${FEEDBACK_TOOL_GUIDANCE.textChanges}
4. ${FEEDBACK_TOOL_GUIDANCE.ambiguous}
5. ${FEEDBACK_TOOL_GUIDANCE.markDone}
Tell the user which requests you fixed, which you asked about, and which you skipped.`;

const CONFIRM_FIRST = "Only call after showing the plan to the user and getting explicit confirmation.";

export interface ServerDependencies {
  platform: PlatformContext;
  fetch?: typeof fetch;
  putFile?: StoragePut;
  sleep?: Sleep;
  random?: Random;
  now?: () => number;
  /** Diagnostics go to stderr; stdout carries only the MCP protocol. */
  log: (message: string) => void;
  /** Overridable for tests. */
  concurrency?: number;
  batchSize?: number;
}

type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

function textResult(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }] };
}

function errorResult(error: unknown): CallToolResult {
  return { isError: true, content: [{ type: "text", text: `Error: ${describeError(error)}` }] };
}

function progressReporter(extra: ToolExtra, now: () => number): ProgressReporter | undefined {
  const progressToken = extra._meta?.progressToken;
  if (progressToken === undefined) return undefined;
  let lastSentAt = 0;
  return (progress, total, message) => {
    const sentAt = now();
    if (progress < total && sentAt - lastSentAt < PROGRESS_MIN_INTERVAL_MS) return;
    lastSentAt = sentAt;
    extra
      .sendNotification({ method: "notifications/progress", params: { progressToken, progress, total, message } })
      .catch(() => undefined);
  };
}

const idSchema = (description: string) => z.string().trim().min(1).max(ID_MAX_LENGTH).describe(description);
const pathsSchema = z
  .array(z.string().min(1).max(PATH_MAX_LENGTH))
  .min(1)
  .max(MAX_PATHS_PER_CALL)
  .describe("Files, folders, or glob patterns (e.g. /abs/photos/**/*.jpg). Prefer absolute paths; relative ones resolve against cwd.");
const cwdSchema = z.string().max(PATH_MAX_LENGTH).optional().describe("Absolute path of the user's project folder; relative paths resolve against it.");
const categoryNamesSchema = z
  .array(z.string().min(1).max(GALLERY_CATEGORY_NAME_MAX_LENGTH))
  .max(MAX_CATEGORIES_PER_CALL);
const layoutSchema = z.enum(["grid", "collage"]).optional().describe("grid (even tiles) or collage (masonry).");
const gridFitSchema = z.enum(["cover", "contain"]).optional().describe("cover crops grid tiles; contain letterboxes them to show the whole item.");
const pageSizeSchema = z
  .number()
  .int()
  .min(GALLERY_PAGE_SIZE_MIN)
  .max(GALLERY_PAGE_SIZE_MAX)
  .nullable()
  .optional()
  .describe(`Items per "Load more" page (${GALLERY_PAGE_SIZE_MIN}–${GALLERY_PAGE_SIZE_MAX}), or null to show everything.`);

/** Accepts `example.com` or a pasted URL like `https://www.example.com/`; returns the bare hostname. */
export function normalizeSiteDomain(input: string): string {
  const trimmed = input.trim().toLowerCase();
  let hostname = trimmed;
  try {
    hostname = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`).hostname;
  } catch {
    // Validated below.
  }
  if (hostname.length > SITE_DOMAIN_MAX_LENGTH || !SITE_DOMAIN_PATTERN.test(hostname)) {
    throw new UserFacingError(`"${input}" isn't a valid website domain. Use a hostname like example.com (no path or port).`);
  }
  return hostname;
}

export function summarizeShowcase(detail: GalleryDetail) {
  const statusCounts: Record<string, number> = {};
  const kindCounts = { photo: 0, video: 0 };
  const videoAvailability: Record<string, number> = {};
  let uncategorized = 0;
  for (const item of detail.images) {
    statusCounts[item.status] = (statusCounts[item.status] ?? 0) + 1;
    kindCounts[item.kind] += 1;
    if (item.categoryIds.length === 0) uncategorized += 1;
    if (item.video) videoAvailability[item.video.availability] = (videoAvailability[item.video.availability] ?? 0) + 1;
  }
  const failedItems = truncateList(
    detail.images.filter((item) => item.status === "failed").map((item) => ({ id: item.id, fileName: item.sourceFileName, reason: item.failureReason })),
    MAX_LISTED_FAILED_ITEMS,
  );
  return {
    id: detail.id,
    publicId: detail.publicId,
    title: detail.title,
    settings: { layout: detail.layout, gridFit: detail.gridFit, showCategoryFilters: detail.showCategoryFilters, pageSize: detail.pageSize },
    itemCount: detail.images.length,
    photos: kindCounts.photo,
    videos: kindCounts.video,
    byStatus: statusCounts,
    videoAvailability,
    categories: detail.categories.map((category) => ({ id: category.id, name: category.name, slug: category.slug, itemCount: category.itemCount })),
    uncategorized,
    failedItems: failedItems.items,
    failedItemsOmitted: failedItems.omitted,
    updatedAt: detail.updatedAt,
  };
}

function siteSummary(site: PublicApiSite) {
  return { id: site.id, name: site.name, isDefault: site.isDefault, domains: site.domains, canEdit: site.canEdit };
}

function usageSummary(usage: UsageSummaryResponse) {
  const meter = (used: number, limit: number) => ({
    used: formatBytes(used),
    limit: formatBytes(limit),
    percent: limit > 0 ? Math.round((used / limit) * PERCENT) : null,
    remaining: formatBytes(Math.max(0, limit - used)),
  });
  return {
    period: { start: usage.periodStart, end: usage.periodEnd, isTrial: usage.isTrialPeriod },
    storage: meter(usage.storage.usedBytes, usage.storage.limitBytes),
    bandwidth: { ...meter(usage.bandwidth.usedBytes, usage.bandwidth.limitBytes), tracked: usage.bandwidthTracked },
    uploadedThisPeriod: formatBytes(usage.uploadedBytes),
    uploadsSuspended: usage.uploadsSuspended,
    playbackSuspended: usage.playbackSuspended,
    suspensionReason: usage.suspensionReason,
    updatedAt: usage.updatedAt,
  };
}

export function createDroplServer(dependencies: ServerDependencies): McpServer {
  const now = dependencies.now ?? Date.now;
  const sleep = dependencies.sleep ?? defaultSleep;
  const random = dependencies.random ?? Math.random;
  const configDir = configDirectory(dependencies.platform);
  const credentialsFilePath = credentialsPath(configDir);

  async function connect(
    clientOptions: { maxAttempts?: number; requestTimeoutMs?: number } = {},
  ): Promise<{ client: DroplApiClient; credentials: ResolvedCredentials }> {
    const apiUrl = resolveApiUrl(dependencies.platform.env);
    const credentials = await resolveCredentials({
      env: dependencies.platform.env,
      apiUrl,
      credentialsFilePath,
      platform: dependencies.platform.platform,
    });
    const client = new DroplApiClient({ apiUrl, apiKey: credentials.apiKey, fetch: dependencies.fetch, sleep, random, ...clientOptions });
    return { client, credentials };
  }

  function uploadContext(client: DroplApiClient, extra: ToolExtra): MediaUploadContext {
    return {
      client,
      configDirectory: configDir,
      putFile: dependencies.putFile ?? putToStorage,
      sleep,
      random,
      now,
      warn: dependencies.log,
      onProgress: progressReporter(extra, now),
      signal: extra.signal,
      concurrency: dependencies.concurrency,
      batchSize: dependencies.batchSize,
    };
  }

  async function run(toolName: string, action: () => Promise<unknown>): Promise<CallToolResult> {
    try {
      return textResult(await action());
    } catch (error) {
      const expected = error instanceof UserFacingError || error instanceof CollectionToolError || error instanceof CredentialsError || error instanceof ConfigError;
      if (!expected) dependencies.log(`[dropl-mcp] ${toolName} failed: ${describeError(error)}`);
      return errorResult(error);
    }
  }

  const server = new McpServer({ name: SERVER_NAME, version: PACKAGE_VERSION }, { instructions: SERVER_INSTRUCTIONS });

  server.registerTool(
    "whoami",
    {
      title: "Who am I",
      description: "Shows the connected Dropl account, user, role, API key (name, prefix, scopes, site restriction) and web app URL. Use it to check the connection.",
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    () =>
      run("whoami", async () => {
        const { client, credentials } = await connect();
        const me = await client.get<PublicApiMeResponse>("/v1/me");
        return {
          account: me.organization,
          user: me.user,
          role: me.role,
          apiKey: {
            name: me.apiKey.name,
            prefix: `${me.apiKey.prefix}…`,
            scopes: me.apiKey.scopes,
            sites: me.apiKey.siteIds ?? "all client sites",
            expiresAt: me.apiKey.expiresAt,
            source: credentials.source === "env" ? "DROPL_API_KEY environment variable" : "saved sign-in",
          },
          webAppUrl: me.webAppUrl,
          apiUrl: client.apiUrl,
        };
      }),
  );

  server.registerTool(
    "list_sites",
    {
      title: "List client sites",
      description: "Lists the client sites (websites) this key can reach, with their domains and the plan's site allowance.",
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    () =>
      run("list_sites", async () => {
        const { client } = await connect();
        const response = await client.get<PublicApiSitesResponse>("/v1/sites");
        return { sites: response.sites.map(siteSummary), allowance: response.allowance };
      }),
  );

  server.registerTool(
    "create_site",
    {
      title: "Create client site",
      description: `Creates a client site (one per client website). Check list_sites first to avoid duplicates. ${CONFIRM_FIRST} Safe to retry: the same name and domain return the same site.`,
      inputSchema: {
        name: z.string().trim().min(1).max(WORKSPACE_NAME_MAX_LENGTH).describe("Client or website name, e.g. \"Acme Builders\"."),
        domain: z.string().trim().min(1).max(SITE_DOMAIN_MAX_LENGTH).optional().describe("The website's hostname, e.g. acme.com."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    ({ name, domain }) =>
      run("create_site", async () => {
        const { client } = await connect();
        const body: PublicApiCreateSiteRequest = { name };
        if (domain) body.domain = normalizeSiteDomain(domain);
        const response = await client.request<PublicApiSite>("POST", "/v1/sites", { body, idempotencyKey: deriveIdempotencyKey("sites.create", body) });
        return { site: siteSummary(response.data), alreadyCreated: response.replayed };
      }),
  );

  server.registerTool(
    "list_showcases",
    {
      title: "List showcases",
      description: "Lists a client site's showcases (photo/video galleries), newest first.",
      inputSchema: {
        siteId: idSchema("Client site id from list_sites."),
        cursor: z.string().max(ID_MAX_LENGTH).optional().describe("nextCursor from a previous call."),
        limit: z.number().int().min(1).max(GALLERY_LIST_MAX_LIMIT).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ siteId, cursor, limit }) =>
      run("list_showcases", async () => {
        const { client } = await connect();
        const response = await client.get<GalleryListResponse>(`/v1/sites/${pathSegment(siteId)}/showcases`, { query: { cursor, limit } });
        return {
          showcases: response.galleries.map((gallery) => ({
            id: gallery.id,
            publicId: gallery.publicId,
            title: gallery.title,
            layout: gallery.layout,
            itemCount: gallery.itemCount,
            videoCount: gallery.videoCount,
            ...(gallery.isPrivate === true ? { private: true, note: "Private client photos from feedback: never public and can't be embedded." } : {}),
            updatedAt: gallery.updatedAt,
          })),
          nextCursor: response.nextCursor,
        };
      }),
  );

  server.registerTool(
    "create_showcase",
    {
      title: "Create showcase",
      description: `Creates a showcase (an embeddable photo/video gallery) in a client site. ${CONFIRM_FIRST} Turn on showCategoryFilters when items will be grouped into categories. Safe to retry with the same arguments.`,
      inputSchema: {
        siteId: idSchema("Client site id from list_sites or create_site."),
        title: z.string().trim().min(1).max(GALLERY_TITLE_MAX_LENGTH),
        layout: layoutSchema,
        gridFit: gridFitSchema,
        showCategoryFilters: z.boolean().optional().describe("Show category filter tabs above the items."),
        pageSize: pageSizeSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    ({ siteId, ...settings }) =>
      run("create_showcase", async () => {
        const { client } = await connect();
        const body: PublicApiCreateShowcaseRequest = settings;
        const response = await client.request<GalleryDetail>("POST", `/v1/sites/${pathSegment(siteId)}/showcases`, {
          body,
          idempotencyKey: deriveIdempotencyKey("showcases.create", siteId, body),
        });
        return { showcase: summarizeShowcase(response.data), alreadyCreated: response.replayed };
      }),
  );

  server.registerTool(
    "get_showcase",
    {
      title: "Get showcase",
      description: "Summarizes a showcase: settings, item counts by status (processing/ready/failed) and kind, categories with counts, and failed items.",
      inputSchema: { showcaseId: idSchema("Showcase id.") },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ showcaseId }) =>
      run("get_showcase", async () => {
        const { client } = await connect();
        return summarizeShowcase(await client.get<GalleryDetail>(showcasePath(showcaseId)));
      }),
  );

  server.registerTool(
    "update_showcase",
    {
      title: "Update showcase settings",
      description: "Changes a showcase's title, layout, grid fit, category filter tabs, or page size.",
      inputSchema: {
        showcaseId: idSchema("Showcase id."),
        title: z.string().trim().min(1).max(GALLERY_TITLE_MAX_LENGTH).optional(),
        layout: layoutSchema,
        gridFit: gridFitSchema,
        showCategoryFilters: z.boolean().optional(),
        pageSize: pageSizeSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    ({ showcaseId, ...changes }) =>
      run("update_showcase", async () => {
        const body: UpdateGalleryRequest = changes;
        if (Object.keys(body).length === 0) throw new UserFacingError("Nothing to change: pass at least one setting.");
        const { client } = await connect();
        return summarizeShowcase(await client.patch<GalleryDetail>(showcasePath(showcaseId), body));
      }),
  );

  server.registerTool(
    "create_category",
    {
      title: "Create category",
      description: "Adds a category (filter tab) to a showcase. If one with the same name or slug exists, it's returned instead of creating a duplicate.",
      inputSchema: {
        showcaseId: idSchema("Showcase id."),
        name: z.string().trim().min(1).max(GALLERY_CATEGORY_NAME_MAX_LENGTH),
        slug: z.string().regex(GALLERY_CATEGORY_SLUG_PATTERN).max(GALLERY_CATEGORY_SLUG_MAX_LENGTH).optional().describe("URL form, e.g. kitchen-remodels; derived from the name if omitted."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    ({ showcaseId, name, slug }) =>
      run("create_category", async () => {
        const { client } = await connect();
        const normalizedName = normalizeCategoryName(name);
        if (!normalizedName) throw new UserFacingError("Category name can't be empty.");
        const showcase = await client.get<GalleryDetail>(showcasePath(showcaseId));
        const existing = findCategory(showcase.categories, normalizedName) ?? (slug ? showcase.categories.find((category) => category.slug === slug) : undefined);
        if (existing) return { category: existing, existed: true };
        if (!slug) {
          const [created] = (await ensureCategories(client, showcaseId, [normalizedName], showcase.categories)).values();
          return { category: created, existed: !created?.created };
        }
        const body: CreateGalleryCategoryRequest = { name: normalizedName, slug };
        const created = await client.post<GalleryCategorySummary>(`${showcasePath(showcaseId)}/categories`, body, {
          idempotencyKey: deriveIdempotencyKey("categories.create", showcaseId, body),
        });
        return { category: created, existed: false };
      }),
  );

  server.registerTool(
    "tag_items",
    {
      title: "Tag showcase items",
      description: "Adds and/or removes categories on showcase items (photos or videos; item ids come from get_showcase or upload results). Category names that don't exist yet are created.",
      inputSchema: {
        showcaseId: idSchema("Showcase id."),
        itemIds: z.array(z.string().min(1).max(ID_MAX_LENGTH)).min(1).max(MAX_ITEM_IDS_PER_CALL),
        addCategoryIds: z.array(z.string().min(1).max(ID_MAX_LENGTH)).max(MAX_CATEGORIES_PER_CALL).optional(),
        addCategoryNames: categoryNamesSchema.optional(),
        removeCategoryIds: z.array(z.string().min(1).max(ID_MAX_LENGTH)).max(MAX_CATEGORIES_PER_CALL).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    ({ showcaseId, itemIds, addCategoryIds, addCategoryNames, removeCategoryIds }) =>
      run("tag_items", async () => {
        const { client } = await connect();
        const addIds = new Set(addCategoryIds ?? []);
        const names = (addCategoryNames ?? []).map(normalizeCategoryName).filter((name): name is string => name !== null);
        let createdCategories: string[] = [];
        if (names.length > 0) {
          const showcase = await client.get<GalleryDetail>(showcasePath(showcaseId));
          const resolved = await ensureCategories(client, showcaseId, names, showcase.categories);
          for (const category of resolved.values()) addIds.add(category.id);
          createdCategories = [...resolved.values()].filter((category) => category.created).map((category) => category.name);
        }
        const removeIds = removeCategoryIds ?? [];
        if (addIds.size === 0 && removeIds.length === 0) throw new UserFacingError("Pass categories to add or remove.");
        await bulkTagItems(client, showcaseId, [...new Set(itemIds)], {
          ...(addIds.size > 0 ? { addCategoryIds: [...addIds] } : {}),
          ...(removeIds.length > 0 ? { removeCategoryIds: removeIds } : {}),
        });
        return { tagged: new Set(itemIds).size, addedCategoryIds: [...addIds], removedCategoryIds: removeIds, createdCategories };
      }),
  );

  server.registerTool(
    "upload_photos",
    {
      title: "Upload photos",
      description: `Uploads local photos (JPEG, PNG, WebP, AVIF, HEIC; up to 20 MB each) into a showcase, straight to storage. Accepts files, folders (recursive by default) and globs; skips hidden files and validates file contents. Run with dryRun: true first and show the result to the user; ${CONFIRM_FIRST} Resumable: re-running with the same arguments skips files already uploaded. categoryFromFolder tags each photo with its top-level folder's name; categories tags every photo (both created if missing).`,
      inputSchema: {
        showcaseId: idSchema("Showcase id from create_showcase or list_showcases."),
        paths: pathsSchema,
        cwd: cwdSchema,
        recursive: z.boolean().optional().describe("Include subfolders (default true)."),
        categoryFromFolder: z.boolean().optional().describe("Tag photos with their top-level folder name as a category (default false)."),
        categories: categoryNamesSchema.optional().describe("Category names to tag every uploaded photo with."),
        dryRun: z.boolean().optional().describe("Only check the files and report what would be uploaded."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    (input, extra) =>
      run("upload_photos", async () => {
        const { client } = await connect();
        return uploadPhotos(input, uploadContext(client, extra));
      }),
  );

  server.registerTool(
    "list_videos",
    {
      title: "List videos",
      description: "Lists videos in a client site's library (newest first), optionally filtered by a title search. Use it to find video ids for embeds or showcases.",
      inputSchema: {
        siteId: idSchema("Client site id."),
        search: z.string().max(GALLERY_TITLE_MAX_LENGTH).optional(),
        cursor: z.string().max(ID_MAX_LENGTH).optional(),
        limit: z.number().int().min(1).max(VIDEO_LIST_MAX_LIMIT).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ siteId, search, cursor, limit }) =>
      run("list_videos", async () => {
        const { client } = await connect();
        const response = await client.get<VideoListResponse>(`/v1/sites/${pathSegment(siteId)}/videos`, { query: { search, cursor, limit } });
        return {
          videos: response.videos.map((video) => ({
            id: video.id,
            publicId: video.publicId,
            title: video.title,
            status: video.status,
            visibility: video.visibility,
            durationMs: video.durationMs,
            createdAt: video.createdAt,
          })),
          nextCursor: response.nextCursor,
        };
      }),
  );

  server.registerTool(
    "upload_videos",
    {
      title: "Upload videos",
      description: `Uploads local videos (MP4, MOV, WebM, MKV, AVI, MPEG, M4V) to a client site's library in resumable parts, titled from their file names. With showcaseId, also adds them to that showcase (and applies categories / categoryFromFolder). Run with dryRun: true first; ${CONFIRM_FIRST} Re-running with the same arguments resumes interrupted uploads and skips finished ones.`,
      inputSchema: {
        siteId: idSchema("Client site id."),
        paths: pathsSchema,
        cwd: cwdSchema,
        recursive: z.boolean().optional().describe("Include subfolders (default true)."),
        showcaseId: idSchema("Showcase (in the same site) to add the videos to.").optional(),
        categoryFromFolder: z.boolean().optional().describe("With showcaseId: tag each video with its top-level folder name."),
        categories: categoryNamesSchema.optional().describe("With showcaseId: categories to tag every video with."),
        dryRun: z.boolean().optional().describe("Only check the files and report what would be uploaded."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    (input, extra) =>
      run("upload_videos", async () => {
        const { client } = await connect();
        return uploadVideos(input, uploadContext(client, extra));
      }),
  );

  server.registerTool(
    "add_videos_to_showcase",
    {
      title: "Add videos to showcase",
      description: "Adds existing library videos (from the showcase's client site) to a showcase. Videos already in it are skipped.",
      inputSchema: {
        showcaseId: idSchema("Showcase id."),
        videoIds: z.array(z.string().min(1).max(ID_MAX_LENGTH)).min(1).max(MAX_ITEM_IDS_PER_CALL),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    ({ showcaseId, videoIds }) =>
      run("add_videos_to_showcase", async () => {
        const { client } = await connect();
        const uniqueIds = [...new Set(videoIds)];
        for (const batch of chunk(uniqueIds, MAX_GALLERY_VIDEOS_PER_REQUEST)) {
          const body: AddGalleryVideosRequest = { videoIds: batch };
          await client.post<unknown>(`${showcasePath(showcaseId)}/videos`, body);
        }
        return { showcaseId, added: uniqueIds.length, nextStep: "Use tag_items to put them in categories, or get_embed_code for the snippet." };
      }),
  );

  server.registerTool(
    "get_embed_code",
    {
      title: "Get embed code",
      description: "Returns the official embed snippet for a video (videoId) or a showcase (showcaseId, optionally one category by name or slug), plus where and how to paste it (plain HTML, React/Next.js, WordPress, Webflow, Framer). Always use this instead of writing embed HTML by hand.",
      inputSchema: {
        videoId: idSchema("Video id.").optional(),
        showcaseId: idSchema("Showcase id.").optional(),
        category: z.string().max(GALLERY_CATEGORY_SLUG_MAX_LENGTH).optional().describe("With showcaseId: a category name or slug, to embed only that category without filter tabs."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ videoId, showcaseId, category }) =>
      run("get_embed_code", async () => {
        if (Boolean(videoId) === Boolean(showcaseId)) throw new UserFacingError("Pass either videoId or showcaseId.");
        if (videoId && category) throw new UserFacingError("category only applies to showcases.");
        const { client } = await connect();
        if (videoId) return videoEmbedResult(await client.get<PublicApiVideoEmbedResponse>(`/v1/videos/${pathSegment(videoId)}/embed`));
        return showcaseEmbedResult(await client.get<PublicApiShowcaseEmbedResponse>(`${showcasePath(showcaseId!)}/embed`), category);
      }),
  );

  server.registerTool(
    "get_usage",
    {
      title: "Get usage",
      description: "Shows storage and bandwidth used against the plan's limits this period, and whether uploads or playback are suspended.",
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    () =>
      run("get_usage", async () => {
        const { client } = await connect();
        return usageSummary(await client.get<UsageSummaryResponse>("/v1/usage"));
      }),
  );

  server.registerTool(
    "plan_migration",
    {
      title: "Plan a media migration",
      description: "Scans a local folder (no upload) and proposes how to bring it into Dropl: top-level folders become categories, photo/video counts and sizes per folder, unsupported files by reason, upload batches, whether it needs several showcases, remaining storage (when signed in) and the tool calls to run. Run this first and show the plan to the user for confirmation.",
      inputSchema: {
        path: z.string().min(1).max(PATH_MAX_LENGTH).describe("Folder to scan; prefer an absolute path."),
        cwd: cwdSchema,
        recursive: z.boolean().optional().describe("Include subfolders (default true)."),
        categoryFromFolder: z.boolean().optional().describe("Turn top-level folders into categories (default true)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (input) =>
      run("plan_migration", async () => {
        let usage: UsageSummaryResponse | null = null;
        try {
          const { client } = await connect({ maxAttempts: 1, requestTimeoutMs: USAGE_PROBE_TIMEOUT_MS });
          usage = await client.get<UsageSummaryResponse>("/v1/usage");
        } catch {
          // The plan works offline; storage just isn't included.
        }
        return planMigration(input, usage);
      }),
  );

  server.registerTool(
    "list_collections",
    {
      title: "List collections",
      description: COLLECTION_TOOL_DESCRIPTIONS.list_collections,
      inputSchema: {
        siteId: idSchema("Client site id (from list_sites)."),
        trashed: z.boolean().optional().describe("List trashed collections instead (restorable for 30 days)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ siteId, trashed }) =>
      run("list_collections", async () => {
        const { client } = await connect();
        return collectionListResult(await client.get<CollectionListResponse>(`${sitePath(siteId)}/collections`, { query: { trashed: trashed ? "true" : undefined } }));
      }),
  );

  server.registerTool(
    "get_collection_schema",
    {
      title: "Get collection schema",
      description: COLLECTION_TOOL_DESCRIPTIONS.get_collection_schema,
      inputSchema: { collectionId: idSchema("Collection id (from list_collections).") },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ collectionId }) =>
      run("get_collection_schema", async () => {
        const { client } = await connect();
        const { typescript: _typescript, ...schema } = await client.get<CollectionSchemaResponse>(`${collectionPath(collectionId)}/schema`);
        return schema;
      }),
  );

  server.registerTool(
    "plan_collections",
    {
      title: "Plan collections",
      description: `${COLLECTION_TOOL_DESCRIPTIONS.plan_collections} Show the summary to the user before apply_collection_plan.`,
      inputSchema: {
        siteId: idSchema("Client site id (from list_sites)."),
        collections: collectionPlanSchema,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ siteId, collections }) =>
      run("plan_collections", async () => {
        const { client } = await connect();
        const body = { collections, dryRun: true };
        return planResult(await client.post<CollectionPlanResponse>(`${sitePath(siteId)}/collections/plan`, body), true);
      }),
  );

  server.registerTool(
    "apply_collection_plan",
    {
      title: "Apply collection plan",
      description: `${COLLECTION_TOOL_DESCRIPTIONS.apply_collection_plan} ${CONFIRM_FIRST}`,
      inputSchema: {
        siteId: idSchema("Client site id (from list_sites)."),
        collections: collectionPlanSchema,
        confirmDestructive: z.boolean().optional().describe("Only after the user explicitly agreed to every destructive change in the plan."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    ({ siteId, collections, confirmDestructive }) =>
      run("apply_collection_plan", async () => {
        const { client } = await connect();
        const body = { collections, dryRun: false, confirmDestructive: confirmDestructive === true };
        return planResult(await client.post<CollectionPlanResponse>(`${sitePath(siteId)}/collections/plan`, body), false);
      }),
  );

  server.registerTool(
    "add_collection_items",
    {
      title: "Add collection items",
      description: `${COLLECTION_TOOL_DESCRIPTIONS.add_collection_items} Run with dryRun: true (the default) first; saving (dryRun: false) needs explicit confirmation. Accepts up to ${MAX_COLLECTION_ITEMS_PER_CALL} items, sent in batches; retrying the same call doesn't duplicate items.`,
      inputSchema: {
        collectionId: idSchema("Collection id (from list_collections)."),
        items: z.array(collectionItemInputSchema).min(1).max(MAX_COLLECTION_ITEMS_PER_CALL),
        dryRun: z.boolean().optional().describe("Validate only (default true)."),
        mode: z.enum(["valid_only", "all_or_nothing"]).optional().describe("valid_only (default) saves the valid items; all_or_nothing saves nothing if any item is invalid."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    ({ collectionId, items, dryRun, mode }) =>
      run("add_collection_items", async () => {
        const { client } = await connect();
        return addCollectionItems(client, { collectionId, items, dryRun: dryRun ?? true, mode: mode ?? "valid_only" });
      }),
  );

  server.registerTool(
    "list_collection_items",
    {
      title: "List collection items",
      description: COLLECTION_TOOL_DESCRIPTIONS.list_collection_items,
      inputSchema: {
        collectionId: idSchema("Collection id (from list_collections)."),
        q: z.string().max(200).optional().describe("Search titles and text fields."),
        status: z.enum(["draft", "published"]).optional(),
        filters: collectionItemFiltersSchema.optional(),
        sort: z.string().max(60).optional().describe("position (default), createdAt, updatedAt, publishedAt, title, or a field key; prefix - for descending."),
        trashed: z.boolean().optional(),
        limit: z.number().int().min(1).max(COLLECTION_ITEMS_PAGE_MAX).optional(),
        offset: z.number().int().min(0).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ collectionId, q, status, filters, sort, trashed, limit, offset }) =>
      run("list_collection_items", async () => {
        const { client } = await connect();
        const query = { q, status, sort, limit, offset, trashed: trashed ? "true" : undefined, ...itemFilterQuery(filters ?? []) };
        return itemListResult(await client.get<CollectionItemListResponse>(`${collectionPath(collectionId)}/items`, { query }));
      }),
  );

  server.registerTool(
    "get_collection_code",
    {
      title: "Get collection code",
      description: COLLECTION_TOOL_DESCRIPTIONS.get_collection_code,
      inputSchema: { collectionId: idSchema("Collection id (from list_collections).") },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ collectionId }) =>
      run("get_collection_code", async () => {
        const { client } = await connect();
        return collectionCodeResult(await client.get<CollectionSchemaResponse>(`${collectionPath(collectionId)}/schema`));
      }),
  );

  server.registerTool(
    "undo_collection_change",
    {
      title: "Undo collection change",
      description: `${COLLECTION_TOOL_DESCRIPTIONS.undo_collection_change} ${CONFIRM_FIRST}`,
      inputSchema: {
        collectionId: idSchema("Collection id (from list_collections)."),
        activityId: idSchema("Activity entry to undo; defaults to the most recent undoable one.").optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    ({ collectionId, activityId }) =>
      run("undo_collection_change", async () => {
        const { client } = await connect();
        const entry = pickUndoableActivity(await client.get<CollectionActivityResponse>(`${collectionPath(collectionId)}/activity`), activityId);
        const result = await client.post<CollectionSchemaChangeResponse>(`${collectionPath(collectionId)}/activity/${pathSegment(entry.id)}/undo`, {});
        return { undone: entry.summary, changes: result.changes, schemaVersion: result.collection.schemaVersion };
      }),
  );

  server.registerTool(
    "list_feedback",
    {
      title: "List client feedback",
      description: `Lists feedback the client left on their website (comments on elements, text changes, general notes), newest first. Defaults to open and in progress. ${FEEDBACK_TOOL_GUIDANCE.textChanges} Use get_feedback for the full context of one request.`,
      inputSchema: {
        siteId: idSchema("Client site id (from list_sites)."),
        status: z.array(z.enum(FEEDBACK_STATUSES)).min(1).max(FEEDBACK_STATUSES.length).optional().describe("Defaults to open and in_progress."),
        type: z.enum(FEEDBACK_REQUEST_TYPES).optional(),
        page: z.string().trim().max(200).optional().describe("Only requests on pages whose path contains this, e.g. /menu."),
        limit: z.number().int().min(1).max(FEEDBACK_LIST_PAGE_MAX).optional(),
        offset: z.number().int().min(0).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ siteId, status, type, page, limit, offset }) =>
      run("list_feedback", async () => {
        const { client } = await connect();
        const query = { status: (status ?? ["open", "in_progress"]).join(","), type, page, limit, offset };
        return feedbackListResult(await client.get<PublicFeedbackListResponse>(`${sitePath(siteId)}/feedback`, { query }), offset ?? 0);
      }),
  );

  server.registerTool(
    "get_feedback",
    {
      title: "Get client feedback",
      description: `Gets one feedback request with its full context: page URL, the clicked element (CSS selector, tag, nearby text, position), device and viewport, screenshot and photo URLs (temporary; fetch them to look), and the thread. ${FEEDBACK_TOOL_GUIDANCE.textChanges} ${FEEDBACK_TOOL_GUIDANCE.ambiguous}`,
      inputSchema: { requestId: idSchema("Feedback request id (from list_feedback).") },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ requestId }) =>
      run("get_feedback", async () => {
        const { client } = await connect();
        return feedbackDetailResult(await client.get<FeedbackRequestDetail>(feedbackPath(requestId)));
      }),
  );

  server.registerTool(
    "reply_to_feedback",
    {
      title: "Reply to client feedback",
      description: `Replies in a feedback request's thread as the signed-in user; the client gets the reply by email. ${FEEDBACK_TOOL_GUIDANCE.ambiguous} Keep replies short and plain (no code). Safe to retry: the same reply isn't posted twice.`,
      inputSchema: {
        requestId: idSchema("Feedback request id (from list_feedback)."),
        message: z.string().trim().min(1).max(FEEDBACK_MESSAGE_MAX_LENGTH),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    ({ requestId, message }) =>
      run("reply_to_feedback", async () => {
        const { client } = await connect();
        const body = { message };
        const response = await client.request<FeedbackMessageSummary>("POST", `${feedbackPath(requestId)}/replies`, {
          body,
          idempotencyKey: deriveIdempotencyKey("feedback.reply", requestId, body),
        });
        return { replied: true, messageId: response.data.id, alreadySent: response.replayed };
      }),
  );

  server.registerTool(
    "update_feedback_status",
    {
      title: "Update feedback status",
      description: `Sets a feedback request to open, in_progress, done, or wont_do. ${FEEDBACK_TOOL_GUIDANCE.markDone} Marking done emails the client; only mark done once the fix is in the code (and deployed, if the user says so).`,
      inputSchema: {
        requestId: idSchema("Feedback request id (from list_feedback)."),
        status: z.enum(FEEDBACK_STATUSES),
        resolutionNote: z.string().trim().max(FEEDBACK_RESOLUTION_NOTE_MAX_LENGTH).optional().describe("Short note for done or wont_do, e.g. \"Updated the opening hours on the contact page.\""),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    ({ requestId, status, resolutionNote }) =>
      run("update_feedback_status", async () => {
        const { client } = await connect();
        const request = await client.patch<FeedbackRequestDetail>(feedbackPath(requestId), { status, resolutionNote: resolutionNote ?? null });
        return { id: request.id, number: request.number, status: request.status, resolutionNote: request.resolutionNote, clientNotified: status === "done" };
      }),
  );

  return server;
}

export async function runStdioServer(dependencies: Partial<ServerDependencies> = {}): Promise<void> {
  const server = createDroplServer({
    platform: currentPlatformContext(),
    log: (message) => process.stderr.write(`${message}\n`),
    ...dependencies,
  });
  await server.connect(new StdioServerTransport());
}
