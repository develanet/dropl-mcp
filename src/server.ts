import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { CallToolResult, ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  ALT_TEXT_GUIDANCE,
  COLLECTION_EDIT_RULES,
  COLLECTION_TOOL_DESCRIPTIONS,
  CollectionToolError,
  GALLERY_CATEGORY_NAME_MAX_LENGTH,
  GALLERY_CATEGORY_SLUG_MAX_LENGTH,
  GALLERY_CATEGORY_SLUG_PATTERN,
  GALLERY_IMAGE_ALT_MAX_LENGTH,
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
  PROJECT_DESCRIPTION_MAX_LENGTH,
  PROJECT_SLUG_MAX_LENGTH,
  PROJECT_SLUG_PATTERN,
  PROJECT_SUBTITLE_MAX_LENGTH,
  PROJECT_TITLE_MAX_LENGTH,
  PROJECT_URL_TEMPLATE_MAX_LENGTH,
  SHOWCASE_TYPE_CODES,
  isProjectUrlTemplate,
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
  type GalleryProjectListResponse,
  type ProjectDetailsSchemaResponse,
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
import {
  LIST_PROJECTS_DEFAULT_LIMIT,
  PROJECT_DETAIL_EDIT_RULES,
  changeProjectDetails,
  createProject,
  findProject,
  listProjectsResult,
  projectDetailFieldsSchema,
  projectDetailValuesSchema,
  projectDetailsPath,
  projectDetailsResult,
  reorderProjectItems,
  reorderProjects,
  requireProjectsShowcase,
  showcaseType,
  updateProject,
} from "./projects.js";
import { sleep as defaultSleep, type Random, type Sleep } from "./retry.js";
import { putToStorage, type StoragePut } from "./storage-put.js";
import type { MediaUploadContext, ProgressReporter } from "./upload-common.js";
import {
  LIST_ITEMS_DEFAULT_LIMIT,
  LIST_ITEMS_MAX_LIMIT,
  listItemsResult,
  localPathsByItemId,
  resolveItemIds,
  updateShowcaseItems,
} from "./showcase-items.js";
import { SERVER_TITLE, SHORT_DESCRIPTION, WEBSITE_URL } from "./metadata.js";
import { PACKAGE_NAME, PACKAGE_VERSION } from "./version.js";
import { uploadVideos } from "./video-upload.js";

const MAX_LISTED_FAILED_ITEMS = 10;
/** Progress notifications are throttled so a big upload doesn't flood the client. */
const PROGRESS_MIN_INTERVAL_MS = 250;
const ID_MAX_LENGTH = 200;
const PATH_MAX_LENGTH = 4096;
const MAX_PATHS_PER_CALL = 1000;
const MAX_ITEM_IDS_PER_CALL = 1000;
const MAX_CATEGORIES_PER_CALL = 50;
const MAX_ITEM_UPDATES_PER_CALL = 1000;
const LIST_SEARCH_MAX_LENGTH = 200;
const PERCENT = 100;
/** Projects are referenced by id, slug, or title. */
const PROJECT_REFERENCE_MAX_LENGTH = Math.max(ID_MAX_LENGTH, PROJECT_TITLE_MAX_LENGTH);
const MAX_PROJECTS_PER_REORDER = 100;
/** plan_migration works offline, so its optional storage lookup must not hold it up. */
const USAGE_PROBE_TIMEOUT_MS = 5_000;

export const SERVER_INSTRUCTIONS = `Dropl hosts client-editable photo and video galleries (showcases), videos, and collections that web studios embed on their clients' websites; clients then update them from the Dropl dashboard or their phone, without a CMS. These tools set that up from the user's codebase: create client sites and showcases, upload local photos and videos, fetch embed code, manage collections, and work through client feedback. Typical flow: whoami, then list_sites (or create_site), create_showcase, upload_photos, and get_embed_code, then paste the embed and build. Before creating or uploading anything, show the user the plan and wait for their explicit confirmation.

Rules:
- Before creating a site or showcase or uploading anything, run plan_migration (or upload_photos / upload_videos with dryRun: true), show the plan to the user (client site, showcase title, categories or projects, file counts and sizes) and get their explicit confirmation. Don't create or upload on your own initiative.
- Prefer existing client sites and showcases (list_sites, list_showcases) over creating duplicates.
- Never ask the user to paste an API key into the chat. If a tool says you're not signed in, ask the user to run \`${LOGIN_COMMAND}\` in their own terminal (or set DROPL_API_KEY in this server's MCP config), then try again.
- Pass absolute paths (or set cwd to the project folder) for uploads.
- Uploads are resumable and idempotent: if one stops partway, run the same call again; finished files are skipped.
- Uploads return each file's id (files[].id); use those ids with update_items or tag_items instead of re-uploading. list_showcase_items pages through every item with its local path, alt text, and categories.
- Alt text: ${ALT_TEXT_GUIDANCE} Set it per photo with upload_photos files[].alt, or later with update_items.
- Use get_embed_code for embed snippets; never write embed HTML by hand.
- After adding an embed to the user's project, run the project's build (or type check) to make sure it still compiles.

Projects showcases (portfolios: an index of projects, each with its own page, photos and videos, description, and details):
- Use create_showcase with type: "projects" when each job or folder is its own project. plan_migration plans one project per folder (with layout: "projects", or on its own for a projects/ folder of project folders).
- Add each project with create_project (title, subtitle like "Custom Home · Zebulon, NC", description, details, categories), then upload into it with upload_photos / upload_videos and project (its slug, title, or id). In a projects showcase every photo and video belongs to a project, and categories belong to projects.
- list_projects pages through the projects, or one project's items; update_project, reorder_projects, and reorder_project_items change them.
- Details (facts every project fills in, like location or square footage) are defined once per showcase. ${PROJECT_DETAIL_EDIT_RULES.readFirst} ${PROJECT_DETAIL_EDIT_RULES.keepKeys} ${PROJECT_DETAIL_EDIT_RULES.confirm}
- get_embed_code with projectUrl (e.g. "/work/{slug}") links the index cards to the website's own project pages; with project it returns that project's page snippet.

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

const COLLECTIONS_PLAN_DESCRIPTION =
  "Collections to create or change, e.g. [{ \"name\": \"Menu\", \"fields\": [{ \"label\": \"Name\", \"type\": \"text\" }, { \"label\": \"Price\", \"type\": \"price\", \"currency\": \"USD\" }] }].";
const CONFIRM_FIRST = "Only call after showing the plan to the user and getting explicit confirmation.";
const PROJECT_DETAILS_FIELDS_DESCRIPTION =
  "Every detail, in order: existing ones with their key (and option values) as read, new ones without, e.g. [{ \"key\": \"location\", \"label\": \"Location\", \"type\": \"short_text\" }, { \"label\": \"Square footage\", \"type\": \"number\", \"unit\": \"sq ft\", \"showOnCard\": true }].";
const projectDetailsVersionSchema = z
  .number()
  .int()
  .min(0)
  .describe("The version you read with get_project_details, e.g. 3.");

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

/** Shown in parameter descriptions; real ids are UUIDs like this one. */
const EXAMPLE_ID = "0190f5c2-7b1e-7c3a-9d2f-1a2b3c4d5e6f";
const withExample = (description: string, example: string) => `${description.replace(/\.$/, "")}, e.g. ${example}.`;
const idSchema = (description: string) => z.string().trim().min(1).max(ID_MAX_LENGTH).describe(withExample(description, `"${EXAMPLE_ID}"`));
const idListSchema = (description: string, maxItems: number) =>
  z.array(z.string().min(1).max(ID_MAX_LENGTH)).max(maxItems).describe(withExample(description, `["${EXAMPLE_ID}"]`));
const pathsSchema = z
  .array(z.string().min(1).max(PATH_MAX_LENGTH))
  .min(1)
  .max(MAX_PATHS_PER_CALL)
  .describe("Files, folders, or glob patterns, e.g. [\"/abs/photos/**/*.jpg\"]. Prefer absolute paths; relative ones resolve against cwd.");
const cwdSchema = z.string().max(PATH_MAX_LENGTH).optional().describe("Absolute path of the user's project folder; relative paths resolve against it, e.g. \"/Users/ana/sites/acme\".");
const recursiveSchema = z.boolean().optional().describe("Include subfolders (default true), e.g. false to upload only the top folder.");
const dryRunSchema = z.boolean().optional().describe("Only check the files and report what would be uploaded, e.g. true for the first call.");
const categoryNamesSchema = z
  .array(z.string().min(1).max(GALLERY_CATEGORY_NAME_MAX_LENGTH))
  .max(MAX_CATEGORIES_PER_CALL);
const layoutSchema = z.enum(["grid", "collage"]).optional().describe("grid (even tiles) or collage (masonry), e.g. \"grid\".");
const gridFitSchema = z.enum(["cover", "contain"]).optional().describe("cover crops grid tiles; contain letterboxes them to show the whole item, e.g. \"cover\".");
const showCategoryFiltersSchema = z.boolean().optional().describe("Show category filter tabs above the items, e.g. true when items are grouped into categories.");
const projectReferenceSchema = (description: string) =>
  z.string().trim().min(1).max(PROJECT_REFERENCE_MAX_LENGTH).describe(withExample(description, "\"arched-entry-two-story\""));
const projectTitleSchema = z.string().trim().min(1).max(PROJECT_TITLE_MAX_LENGTH);
const projectSubtitleSchema = z
  .string()
  .trim()
  .max(PROJECT_SUBTITLE_MAX_LENGTH)
  .nullable()
  .optional()
  .describe("The line under the title, often type and location, e.g. \"Custom Home · Zebulon, NC\"; null clears it.");
const projectDescriptionSchema = z
  .string()
  .trim()
  .max(PROJECT_DESCRIPTION_MAX_LENGTH)
  .nullable()
  .optional()
  .describe("Plain text shown on the project page (cards show its start), e.g. \"A two-story custom home with an arched entry.\"; null clears it.");
const projectSlugSchema = z
  .string()
  .regex(PROJECT_SLUG_PATTERN)
  .max(PROJECT_SLUG_MAX_LENGTH)
  .optional()
  .describe("URL form used in project page links, e.g. \"arched-entry-two-story\"; derived from the title when omitted.");
const projectDetailValuesInputSchema = projectDetailValuesSchema
  .optional()
  .describe("Detail values by key (see get_project_details): numbers as numbers (the unit is separate), select as an option value, dates as YYYY-MM-DD, links as URLs; null clears one, e.g. { \"square_footage\": 3200, \"year\": 2024 }.");
const projectCategoriesSchema = categoryNamesSchema
  .optional()
  .describe("Category names, slugs, or ids (the showcase's filter tabs); missing names are created, e.g. [\"Custom Homes\"].");
const pageSizeSchema = z
  .number()
  .int()
  .min(GALLERY_PAGE_SIZE_MIN)
  .max(GALLERY_PAGE_SIZE_MAX)
  .nullable()
  .optional()
  .describe(`Items per "Load more" page (${GALLERY_PAGE_SIZE_MIN}–${GALLERY_PAGE_SIZE_MAX}), or null to show everything, e.g. 12.`);

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
  const type = showcaseType(detail);
  const projects = detail.projects ?? [];
  return {
    id: detail.id,
    publicId: detail.publicId,
    title: detail.title,
    type,
    settings: { layout: detail.layout, gridFit: detail.gridFit, showCategoryFilters: detail.showCategoryFilters, pageSize: detail.pageSize },
    itemCount: detail.images.length,
    photos: kindCounts.photo,
    videos: kindCounts.video,
    byStatus: statusCounts,
    videoAvailability,
    ...(type === "projects" && {
      projects: {
        count: projects.length,
        withoutReadyItems: projects.filter((project) => project.readyItemCount === 0).length,
        details: (detail.projectDetailFields ?? []).map((field) => field.label),
        detailsVersion: detail.projectDetailsVersion,
        note: "Projects show on the website once they have a ready photo or video. Use list_projects for each project's slug, details, and items.",
      },
    }),
    categories: detail.categories.map((category) => ({
      id: category.id,
      name: category.name,
      slug: category.slug,
      itemCount: category.itemCount,
      ...(type === "projects" && { projectCount: category.projectCount }),
    })),
    uncategorized,
    photosWithoutAltText: detail.images.filter((item) => item.kind === "photo" && !item.altText).length,
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

  const server = new McpServer(
    { name: PACKAGE_NAME, title: SERVER_TITLE, version: PACKAGE_VERSION, description: SHORT_DESCRIPTION, websiteUrl: WEBSITE_URL },
    { instructions: SERVER_INSTRUCTIONS },
  );

  server.registerTool(
    "whoami",
    {
      title: "Who am I",
      description:
        "Shows the connected Dropl account, user, role, and API key (name, prefix, scopes, site restriction) plus the web app URL. Use it first in a session to confirm which account you're acting on, or when another tool reports a sign-in or permission error. Needs a saved sign-in or DROPL_API_KEY; it never returns the full key.",
      annotations: { title: "Who am I", readOnlyHint: true, openWorldHint: false },
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
      description:
        "Lists the client sites (one per client website) this connection can reach, with their domains and the plan's site allowance. Use it before creating anything, to find the site id for the client the user means and avoid duplicate sites. Keys restricted to some sites only see those sites.",
      annotations: { title: "List client sites", readOnlyHint: true, openWorldHint: false },
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
      description: `Creates a client site: the home for one client website's showcases, videos, collections, and feedback. Use it when the client has no site yet; check list_sites first to avoid duplicates. ${CONFIRM_FIRST} Counts toward the plan's site allowance; safe to retry, since the same name and domain return the same site.`,
      inputSchema: {
        name: z.string().trim().min(1).max(WORKSPACE_NAME_MAX_LENGTH).describe("Client or website name, e.g. \"Acme Builders\"."),
        domain: z.string().trim().min(1).max(SITE_DOMAIN_MAX_LENGTH).optional().describe("The website's hostname, e.g. \"acme.com\" (a pasted URL like https://www.acme.com/ also works)."),
      },
      annotations: { title: "Create client site", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
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
      description:
        "Lists a client site's showcases (embeddable photo and video galleries), newest first, with their type (gallery or projects) and item and project counts. Use it to reuse an existing gallery or portfolio instead of creating a duplicate, or to find a showcase id. Paged: pass nextCursor to get more.",
      inputSchema: {
        siteId: idSchema("Client site id from list_sites."),
        cursor: z.string().max(ID_MAX_LENGTH).optional().describe("nextCursor from a previous call, e.g. \"eyJpZCI6IjAxOTAifQ\"."),
        limit: z.number().int().min(1).max(GALLERY_LIST_MAX_LIMIT).optional().describe(`Showcases per page (1–${GALLERY_LIST_MAX_LIMIT}), e.g. 20.`),
      },
      annotations: { title: "List showcases", readOnlyHint: true, openWorldHint: false },
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
            type: showcaseType(gallery),
            layout: gallery.layout,
            itemCount: gallery.itemCount,
            videoCount: gallery.videoCount,
            ...(showcaseType(gallery) === "projects" && { projectCount: gallery.projectCount }),
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
      description: `Creates a showcase: an embeddable photo/video gallery the client can update from their phone. Use it when the user wants a gallery, portfolio, project photos, or a section the client can update themselves. Requires a site id from list_sites or create_site. ${CONFIRM_FIRST} Use type: "projects" for a portfolio where each project gets its own page, photos, and details (then create_project for each); the type can't change once the showcase has items. Turn on showCategoryFilters when items or projects will be grouped into categories. Safe to retry with the same arguments.`,
      inputSchema: {
        siteId: idSchema("Client site id from list_sites or create_site."),
        title: z.string().trim().min(1).max(GALLERY_TITLE_MAX_LENGTH).describe("Gallery title, e.g. \"Our work\"."),
        type: z
          .enum(SHOWCASE_TYPE_CODES)
          .optional()
          .describe("gallery (default: one set of photos and videos) or projects (a portfolio of projects, each with its own page, photos, description, and details), e.g. \"projects\"."),
        layout: layoutSchema,
        gridFit: gridFitSchema,
        showCategoryFilters: showCategoryFiltersSchema,
        pageSize: pageSizeSchema,
      },
      annotations: { title: "Create showcase", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
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
      description:
        "Summarizes a showcase: type, settings, item counts by status (processing/ready/failed) and kind, project counts and details (projects showcases), categories with counts, photos without alt text, and failed items. Use it to check that an upload finished processing or to review a gallery before changing it. It returns counts, not items: use list_showcase_items for ids, alt text, and categories, or list_projects for projects.",
      inputSchema: { showcaseId: idSchema("Showcase id from list_showcases or create_showcase.") },
      annotations: { title: "Get showcase", readOnlyHint: true, openWorldHint: false },
    },
    ({ showcaseId }) =>
      run("get_showcase", async () => {
        const { client } = await connect();
        return summarizeShowcase(await client.get<GalleryDetail>(showcasePath(showcaseId)));
      }),
  );

  server.registerTool(
    "list_showcase_items",
    {
      title: "List showcase items",
      description: `Pages through a showcase's items in display order: id, kind, status, file name, the local path it was uploaded from, alt text, and categories. Use it to find item ids for update_items or tag_items, or photos that still need alt text (missingAlt: true). Up to ${LIST_ITEMS_MAX_LIMIT} items per call; local paths only appear for files uploaded from this machine.`,
      inputSchema: {
        showcaseId: idSchema("Showcase id from list_showcases."),
        kind: z.enum(["photo", "video"]).optional().describe("Only photos or only videos, e.g. \"photo\"."),
        missingAlt: z.boolean().optional().describe("Only photos without alt text, e.g. true."),
        category: z.string().max(GALLERY_CATEGORY_SLUG_MAX_LENGTH).optional().describe("Only items in this category (name, slug, or id), e.g. \"Kitchens\"."),
        search: z.string().trim().max(LIST_SEARCH_MAX_LENGTH).optional().describe("Case-insensitive text in the file name, local path, or alt text, e.g. \"deck\"."),
        offset: z.number().int().min(0).optional().describe("nextOffset from a previous call, e.g. 50."),
        limit: z.number().int().min(1).max(LIST_ITEMS_MAX_LIMIT).optional().describe(`Items per page (default ${LIST_ITEMS_DEFAULT_LIMIT}), e.g. 100.`),
      },
      annotations: { title: "List showcase items", readOnlyHint: true, openWorldHint: false },
    },
    ({ showcaseId, ...filters }) =>
      run("list_showcase_items", async () => {
        const { client } = await connect();
        const detail = await client.get<GalleryDetail>(showcasePath(showcaseId));
        return listItemsResult(detail, await localPathsByItemId(client, configDir, detail, dependencies.log), filters);
      }),
  );

  server.registerTool(
    "update_items",
    {
      title: "Update showcase items",
      description: `Sets alt text and adds/removes categories on many showcase items in one call. Use it after an upload to fix alt text or categories by id (files[].id from upload_photos / upload_videos, library video ids, or ids from list_showcase_items) instead of uploading again. Up to ${MAX_ITEM_UPDATES_PER_CALL} items per call; category names that don't exist yet are created. Alt text: ${ALT_TEXT_GUIDANCE} Show the user the alt text you plan to write before saving a large batch.`,
      inputSchema: {
        showcaseId: idSchema("Showcase id from list_showcases."),
        items: z
          .array(
            z.object({
              id: z.string().min(1).max(ID_MAX_LENGTH).describe(withExample("Item id (or a library video id in this showcase)", `"${EXAMPLE_ID}"`)),
              alt: z
                .string()
                .max(GALLERY_IMAGE_ALT_MAX_LENGTH)
                .nullable()
                .optional()
                .describe("New alt text, e.g. \"Cedar deck with glass railing at dusk\"; empty or null clears it (decorative photo). Omit to leave it unchanged."),
              addCategories: categoryNamesSchema.optional().describe("Category names, slugs, or ids to add, e.g. [\"Decks\"]."),
              removeCategories: categoryNamesSchema.optional().describe("Category names, slugs, or ids to remove, e.g. [\"Uncategorized\"]."),
            }),
          )
          .min(1)
          .max(MAX_ITEM_UPDATES_PER_CALL)
          .describe("Changes per item, e.g. [{ \"id\": \"…\", \"alt\": \"Stone patio with fire pit\", \"addCategories\": [\"Patios\"] }]."),
      },
      annotations: { title: "Update showcase items", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    ({ showcaseId, items }) =>
      run("update_items", async () => {
        if (items.every((item) => item.alt === undefined && !item.addCategories?.length && !item.removeCategories?.length)) {
          throw new UserFacingError("Nothing to change: pass alt, addCategories, or removeCategories for at least one item.");
        }
        const { client } = await connect();
        return updateShowcaseItems(client, showcaseId, items);
      }),
  );

  server.registerTool(
    "update_showcase",
    {
      title: "Update showcase settings",
      description:
        "Changes a showcase's title, layout, grid fit, category filter tabs, or items per page. Use it when the user wants the gallery to look or page differently; embeds pick up the change without new code. Pass only the settings to change; at least one is required.",
      inputSchema: {
        showcaseId: idSchema("Showcase id from list_showcases."),
        title: z.string().trim().min(1).max(GALLERY_TITLE_MAX_LENGTH).optional().describe("New gallery title, e.g. \"Recent projects\"."),
        layout: layoutSchema,
        gridFit: gridFitSchema,
        showCategoryFilters: showCategoryFiltersSchema,
        pageSize: pageSizeSchema,
      },
      annotations: { title: "Update showcase settings", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
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
      description:
        "Adds a category (a filter tab) to a showcase. Use it to group items, e.g. one category per project type or source folder, before tagging them; upload and tagging tools also create missing categories by name. If one with the same name or slug exists, it's returned instead of creating a duplicate.",
      inputSchema: {
        showcaseId: idSchema("Showcase id from list_showcases."),
        name: z.string().trim().min(1).max(GALLERY_CATEGORY_NAME_MAX_LENGTH).describe("Tab label, e.g. \"Kitchen remodels\"."),
        slug: z
          .string()
          .regex(GALLERY_CATEGORY_SLUG_PATTERN)
          .max(GALLERY_CATEGORY_SLUG_MAX_LENGTH)
          .optional()
          .describe("URL form, e.g. \"kitchen-remodels\"; derived from the name if omitted."),
      },
      annotations: { title: "Create category", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
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
      description: `Adds and/or removes the same categories on many showcase items (photos or videos) at once. Use it to put uploaded items into filter tabs, with itemIds from upload_photos / upload_videos (files[].id; library video ids work too) or list_showcase_items. Up to ${MAX_ITEM_IDS_PER_CALL} items per call; category names that don't exist yet are created. For per-item changes or alt text, use update_items.`,
      inputSchema: {
        showcaseId: idSchema("Showcase id from list_showcases."),
        itemIds: z
          .array(z.string().min(1).max(ID_MAX_LENGTH))
          .min(1)
          .max(MAX_ITEM_IDS_PER_CALL)
          .describe(withExample("Item ids (files[].id from uploads, or from list_showcase_items)", `["${EXAMPLE_ID}"]`)),
        addCategoryIds: idListSchema("Existing category ids to add", MAX_CATEGORIES_PER_CALL).optional(),
        addCategoryNames: categoryNamesSchema.optional().describe("Category names to add, created if missing, e.g. [\"Decks\", \"Patios\"]."),
        removeCategoryIds: idListSchema("Category ids to remove", MAX_CATEGORIES_PER_CALL).optional(),
      },
      annotations: { title: "Tag showcase items", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    ({ showcaseId, itemIds, addCategoryIds, addCategoryNames, removeCategoryIds }) =>
      run("tag_items", async () => {
        const { client } = await connect();
        const addIds = new Set(addCategoryIds ?? []);
        const names = (addCategoryNames ?? []).map(normalizeCategoryName).filter((name): name is string => name !== null);
        const showcase = await client.get<GalleryDetail>(showcasePath(showcaseId));
        const uniqueItemIds = [...new Set(resolveItemIds(showcase, itemIds))];
        let createdCategories: string[] = [];
        if (names.length > 0) {
          const resolved = await ensureCategories(client, showcaseId, names, showcase.categories);
          for (const category of resolved.values()) addIds.add(category.id);
          createdCategories = [...resolved.values()].filter((category) => category.created).map((category) => category.name);
        }
        const removeIds = removeCategoryIds ?? [];
        if (addIds.size === 0 && removeIds.length === 0) throw new UserFacingError("Pass categories to add or remove.");
        await bulkTagItems(client, showcaseId, uniqueItemIds, {
          ...(addIds.size > 0 ? { addCategoryIds: [...addIds] } : {}),
          ...(removeIds.length > 0 ? { removeCategoryIds: removeIds } : {}),
        });
        return { tagged: uniqueItemIds.length, addedCategoryIds: [...addIds], removedCategoryIds: removeIds, createdCategories };
      }),
  );

  server.registerTool(
    "upload_photos",
    {
      title: "Upload photos",
      description: `Uploads local photos (JPEG, PNG, WebP, AVIF, HEIC; up to 20 MB each) into a showcase, straight to storage. Use it to turn a folder of project photos into a client-editable gallery: pass files, folders (recursive by default), and globs via paths, and per-photo alt text and categories via files. Skips hidden files and validates file contents. Run with dryRun: true first and show the result to the user; ${CONFIRM_FIRST} Resumable: re-running with the same arguments skips files already uploaded (and still applies changed alt text and categories). categoryFromFolder tags each photo with its top-level folder's name; categories tags every photo (both created if missing). In a projects showcase, pass project: the photos join the end of that project (categories belong to the project there, not to photos); the same file can go into several projects. Returns files: each local path with its showcase item id and status, for update_items and tag_items. Alt text: ${ALT_TEXT_GUIDANCE}`,
      inputSchema: {
        showcaseId: idSchema("Showcase id from create_showcase or list_showcases."),
        project: projectReferenceSchema("Projects showcases only, and required there: the project (slug, title, or id from list_projects or create_project) the photos join").optional(),
        paths: pathsSchema
          .optional()
          .describe("Files, folders, or glob patterns, e.g. [\"/abs/photos/**/*.jpg\"]. Prefer absolute paths; relative ones resolve against cwd. Pass paths, files, or both."),
        files: z
          .array(
            z.object({
              path: z
                .string()
                .min(1)
                .max(PATH_MAX_LENGTH)
                .describe("A photo file (or a folder/glob, applying the same alt text and categories to each), e.g. \"/abs/photos/deck.jpg\"."),
              alt: z
                .string()
                .max(GALLERY_IMAGE_ALT_MAX_LENGTH)
                .nullable()
                .optional()
                .describe(`Alt text, up to ${GALLERY_IMAGE_ALT_MAX_LENGTH} characters, e.g. "Cedar deck with glass railing at dusk". Empty or null for a purely decorative photo; omit to leave it unchanged.`),
              categories: categoryNamesSchema.optional().describe("Categories for this photo (created if missing), e.g. [\"Decks\"]."),
            }),
          )
          .min(1)
          .max(MAX_PATHS_PER_CALL)
          .optional()
          .describe("Photos with their own alt text and categories, e.g. [{ \"path\": \"/abs/photos/deck.jpg\", \"alt\": \"Cedar deck at dusk\", \"categories\": [\"Decks\"] }]."),
        cwd: cwdSchema,
        recursive: recursiveSchema,
        categoryFromFolder: z.boolean().optional().describe("Tag photos with their top-level folder name as a category (default false), e.g. true for Kitchens/ and Decks/ folders."),
        categories: categoryNamesSchema.optional().describe("Category names to tag every uploaded photo with, e.g. [\"Featured\"]."),
        dryRun: dryRunSchema,
      },
      annotations: { title: "Upload photos", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
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
      description:
        "Lists videos in a client site's library (newest first), optionally filtered by a title search. Use it to find video ids for get_embed_code or add_videos_to_showcase, or to check a video is already hosted before uploading it again. Paged: pass nextCursor for more.",
      inputSchema: {
        siteId: idSchema("Client site id from list_sites."),
        search: z.string().max(GALLERY_TITLE_MAX_LENGTH).optional().describe("Text in the video title, e.g. \"hero\"."),
        cursor: z.string().max(ID_MAX_LENGTH).optional().describe("nextCursor from a previous call, e.g. \"eyJpZCI6IjAxOTAifQ\"."),
        limit: z.number().int().min(1).max(VIDEO_LIST_MAX_LIMIT).optional().describe(`Videos per page (1–${VIDEO_LIST_MAX_LIMIT}), e.g. 20.`),
      },
      annotations: { title: "List videos", readOnlyHint: true, openWorldHint: false },
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
      description: `Uploads local videos (MP4, MOV, WebM, MKV, AVI, MPEG, M4V) to a client site's video library in resumable parts, titled from their file names, for streaming playback without YouTube or Vimeo. Use it to host a hero video or a folder of clips; with showcaseId it also adds them to that showcase (and applies categories / categoryFromFolder), and for a projects showcase to the project you pass. Run with dryRun: true first; ${CONFIRM_FIRST} Re-running with the same arguments resumes interrupted uploads and skips finished ones. Returns files: each local path with its library video id.`,
      inputSchema: {
        siteId: idSchema("Client site id from list_sites."),
        paths: pathsSchema,
        cwd: cwdSchema,
        recursive: recursiveSchema,
        showcaseId: idSchema("Showcase (in the same site) to add the videos to.").optional(),
        project: projectReferenceSchema("With a projects showcase, and required there: the project (slug, title, or id) the videos join").optional(),
        categoryFromFolder: z.boolean().optional().describe("With showcaseId: tag each video with its top-level folder name, e.g. true."),
        categories: categoryNamesSchema.optional().describe("With showcaseId: categories to tag every video with, e.g. [\"Tours\"]."),
        dryRun: dryRunSchema,
      },
      annotations: { title: "Upload videos", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
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
      description:
        "Adds existing library videos to a showcase, or to one project of a projects showcase. Use it for videos already hosted in Dropl (ids from list_videos or upload_videos) instead of uploading them again. Videos must belong to the showcase's client site; ones already in it are skipped.",
      inputSchema: {
        showcaseId: idSchema("Showcase id from list_showcases."),
        videoIds: z
          .array(z.string().min(1).max(ID_MAX_LENGTH))
          .min(1)
          .max(MAX_ITEM_IDS_PER_CALL)
          .describe(withExample("Library video ids from list_videos or upload_videos", `["${EXAMPLE_ID}"]`)),
        project: projectReferenceSchema("Projects showcases only, and required there: the project (slug, title, or id) the videos join").optional(),
      },
      annotations: { title: "Add videos to showcase", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    ({ showcaseId, videoIds, project }) =>
      run("add_videos_to_showcase", async () => {
        const { client } = await connect();
        let target: { id: string; slug: string; title: string } | null = null;
        if (project) {
          const detail = await client.get<GalleryDetail>(showcasePath(showcaseId));
          requireProjectsShowcase(detail);
          const found = findProject(detail.projects ?? [], project);
          target = { id: found.id, slug: found.slug, title: found.title };
        }
        const uniqueIds = [...new Set(videoIds)];
        for (const batch of chunk(uniqueIds, MAX_GALLERY_VIDEOS_PER_REQUEST)) {
          const body: AddGalleryVideosRequest = { videoIds: batch, ...(target && { projectId: target.id }) };
          await client.post<unknown>(`${showcasePath(showcaseId)}/videos`, body);
        }
        return {
          showcaseId,
          project: target,
          added: uniqueIds.length,
          nextStep: target ? "Use reorder_project_items to place them in the project, or get_embed_code for the snippet." : "Use tag_items to put them in categories, or get_embed_code for the snippet.",
        };
      }),
  );

  server.registerTool(
    "get_embed_code",
    {
      title: "Get embed code",
      description:
        "Returns the official embed snippet for a video (videoId) or a showcase (showcaseId, optionally one category by name or slug, or one project's page), plus where and how to paste it (plain HTML, React/Next.js, WordPress, Webflow, Framer). Use it whenever a gallery, portfolio, or video goes onto a page. Always use this instead of writing embed HTML by hand; pass exactly one of videoId or showcaseId. Projects showcases: the main snippet is the projects index; projectUrl links its cards to the website's own project pages, and project returns the snippet for one of those pages.",
      inputSchema: {
        videoId: idSchema("Video id from list_videos or upload_videos.").optional(),
        showcaseId: idSchema("Showcase id from list_showcases.").optional(),
        category: z
          .string()
          .max(GALLERY_CATEGORY_SLUG_MAX_LENGTH)
          .optional()
          .describe("With showcaseId: a category name or slug, to embed only that category without filter tabs, e.g. \"kitchens\"."),
        project: projectReferenceSchema("Projects showcases: a project (slug, title, or id) whose page snippet to return, for its own page on the website").optional(),
        projectUrl: z
          .string()
          .trim()
          .max(PROJECT_URL_TEMPLATE_MAX_LENGTH)
          .optional()
          .describe("Projects showcases: the website's project page URL with {slug}, a site path or https URL; index cards then link there instead of opening in place, e.g. \"/work/{slug}\"."),
      },
      annotations: { title: "Get embed code", readOnlyHint: true, openWorldHint: false },
    },
    ({ videoId, showcaseId, category, project, projectUrl }) =>
      run("get_embed_code", async () => {
        if (Boolean(videoId) === Boolean(showcaseId)) throw new UserFacingError("Pass either videoId or showcaseId.");
        if (videoId && (category || project || projectUrl)) throw new UserFacingError("category, project, and projectUrl only apply to showcases.");
        if (projectUrl !== undefined && !isProjectUrlTemplate(projectUrl)) {
          throw new UserFacingError(`projectUrl must be a site path or https URL containing {slug}, without quotes or spaces, e.g. "/work/{slug}"; got "${projectUrl}".`);
        }
        const { client } = await connect();
        if (videoId) return videoEmbedResult(await client.get<PublicApiVideoEmbedResponse>(`/v1/videos/${pathSegment(videoId)}/embed`));
        const response = await client.get<PublicApiShowcaseEmbedResponse>(`${showcasePath(showcaseId!)}/embed`, { query: { projectUrl } });
        return showcaseEmbedResult(response, { category, project, projectUrl });
      }),
  );

  server.registerTool(
    "get_usage",
    {
      title: "Get usage",
      description:
        "Shows storage and bandwidth used against the plan's limits this period, and whether uploads or playback are suspended. Use it before a large upload, or when the user asks how much space is left. Figures cover the whole account, not one client site.",
      annotations: { title: "Get usage", readOnlyHint: true, openWorldHint: false },
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
      description:
        "Scans a local folder without uploading and proposes how to bring it into Dropl: top-level folders become categories (or, for a portfolio, projects), photo/video counts and sizes per folder, unsupported files by reason, upload batches, whether it needs several showcases, remaining storage, and the tool calls to run. Use it first for any folder-to-gallery move or site migration, then show the plan to the user for confirmation. Projects layout (one folder per project, each becoming a project page with a title and slug from its folder name): pass layout: \"projects\" (each subfolder of path, or of its projects/ folder, is a project); it's also picked on its own when path holds a projects/ folder of project folders, unless you pass layout: \"gallery\". Works offline; remaining storage is only included when signed in.",
      inputSchema: {
        path: z.string().min(1).max(PATH_MAX_LENGTH).describe("Folder to scan; prefer an absolute path, e.g. \"/Users/ana/sites/acme/public/projects\"."),
        cwd: cwdSchema,
        recursive: recursiveSchema,
        categoryFromFolder: z.boolean().optional().describe("Gallery layout: turn top-level folders into categories (default true), e.g. false for one flat gallery."),
        layout: z
          .enum(["gallery", "projects"])
          .optional()
          .describe("gallery (one showcase, folders as categories) or projects (one project per folder); omitted, projects only for a projects/ folder of project folders, e.g. \"projects\"."),
      },
      annotations: { title: "Plan a media migration", readOnlyHint: true, openWorldHint: false },
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
    "list_projects",
    {
      title: "List projects",
      description: `Lists a projects showcase's projects in order: slug, title, subtitle, a description excerpt, detail values by key, categories, and item counts. With project, it returns that project's full description, labeled details, and its photos and videos in order (ids, local paths, alt text). Use it to find a project's slug for upload_photos and update_project, or item ids for update_items, reorder_project_items, and covers. Paged: pass nextOffset as offset (${LIST_PROJECTS_DEFAULT_LIMIT} projects or ${LIST_ITEMS_DEFAULT_LIMIT} items per page by default).`,
      inputSchema: {
        showcaseId: idSchema("Projects showcase id from list_showcases."),
        project: projectReferenceSchema("A project (slug, title, or id) to list with its items").optional(),
        offset: z.number().int().min(0).optional().describe("nextOffset from a previous call, e.g. 20."),
        limit: z.number().int().min(1).max(LIST_ITEMS_MAX_LIMIT).optional().describe(`Projects (or, with project, items) per page, up to ${LIST_ITEMS_MAX_LIMIT}, e.g. 50.`),
      },
      annotations: { title: "List projects", readOnlyHint: true, openWorldHint: false },
    },
    ({ showcaseId, ...options }) =>
      run("list_projects", async () => {
        const { client } = await connect();
        const [detail, list] = await Promise.all([
          client.get<GalleryDetail>(showcasePath(showcaseId)),
          client.get<GalleryProjectListResponse>(`${showcasePath(showcaseId)}/projects`),
        ]);
        requireProjectsShowcase(detail);
        const localPaths = options.project ? await localPathsByItemId(client, configDir, detail, dependencies.log) : new Map<string, string>();
        return listProjectsResult(list, detail, localPaths, options);
      }),
  );

  server.registerTool(
    "create_project",
    {
      title: "Create project",
      description: `Creates a project at the end of a projects showcase: title, subtitle (e.g. type and location), description, detail values by key, and categories. Use it for each job in a portfolio, then upload its photos with upload_photos and project. ${CONFIRM_FIRST} A project with the same title (or slug) is returned instead of a duplicate, and retries are safe; category names that don't exist yet are created.`,
      inputSchema: {
        showcaseId: idSchema("Projects showcase id from list_showcases or create_showcase."),
        title: projectTitleSchema.describe("Project title, e.g. \"Arched Entry Two-Story\"."),
        subtitle: projectSubtitleSchema,
        description: projectDescriptionSchema,
        slug: projectSlugSchema,
        details: projectDetailValuesInputSchema,
        categories: projectCategoriesSchema,
      },
      annotations: { title: "Create project", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    ({ showcaseId, ...input }) =>
      run("create_project", async () => {
        const { client } = await connect();
        return createProject(client, showcaseId, input);
      }),
  );

  server.registerTool(
    "update_project",
    {
      title: "Update project",
      description:
        "Changes a project's title, subtitle, description, slug, detail values, categories, or cover photo. Use it to fill in or correct a project, e.g. with details from the old site. Pass only what changes: details merge (null clears one), categories replace the project's categories, and a new title keeps the slug unless you pass one (changing a slug breaks links to the old project page).",
      inputSchema: {
        showcaseId: idSchema("Projects showcase id from list_showcases."),
        project: projectReferenceSchema("The project to change (slug, title, or id)"),
        title: projectTitleSchema.optional().describe("New title, e.g. \"Arched Entry Two-Story\"."),
        subtitle: projectSubtitleSchema,
        description: projectDescriptionSchema,
        slug: projectSlugSchema.describe("New URL form, only when the user wants it changed, e.g. \"arched-entry\"."),
        details: projectDetailValuesInputSchema,
        categories: projectCategoriesSchema.describe("The project's categories (replacing the current ones): names, slugs, or ids; missing names are created, e.g. [\"Custom Homes\"]."),
        cover: z
          .string()
          .trim()
          .min(1)
          .max(ID_MAX_LENGTH)
          .nullable()
          .optional()
          .describe(withExample("Item id of a photo in this project (from list_projects with project), or null to use its first ready photo", `"${EXAMPLE_ID}"`)),
      },
      annotations: { title: "Update project", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    ({ showcaseId, project, ...changes }) =>
      run("update_project", async () => {
        const { client } = await connect();
        return updateProject(client, showcaseId, project, changes);
      }),
  );

  server.registerTool(
    "reorder_projects",
    {
      title: "Reorder projects",
      description:
        "Sets the order of a projects showcase's projects on the website. Use it when the user wants projects in a specific order, e.g. newest or featured first. Pass projects in the new order; ones you leave out keep their current order after them.",
      inputSchema: {
        showcaseId: idSchema("Projects showcase id from list_showcases."),
        projects: z
          .array(z.string().trim().min(1).max(PROJECT_REFERENCE_MAX_LENGTH))
          .min(1)
          .max(MAX_PROJECTS_PER_REORDER)
          .describe("Projects (slugs, titles, or ids) in their new order, e.g. [\"arched-entry-two-story\", \"lakeside-remodel\"]."),
      },
      annotations: { title: "Reorder projects", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    ({ showcaseId, projects }) =>
      run("reorder_projects", async () => {
        const { client } = await connect();
        return reorderProjects(client, showcaseId, projects);
      }),
  );

  server.registerTool(
    "reorder_project_items",
    {
      title: "Reorder project items",
      description:
        "Sets the order of the photos and videos inside one project. Use it to choose which photos lead a project page (the cover is set with update_project). Pass item ids in the new order (from list_projects with project; library video ids work too); ones you leave out keep their current order after them.",
      inputSchema: {
        showcaseId: idSchema("Projects showcase id from list_showcases."),
        project: projectReferenceSchema("The project (slug, title, or id)"),
        itemIds: z
          .array(z.string().min(1).max(ID_MAX_LENGTH))
          .min(1)
          .max(MAX_ITEM_IDS_PER_CALL)
          .describe(withExample("Item ids in their new order", `["${EXAMPLE_ID}"]`)),
      },
      annotations: { title: "Reorder project items", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    ({ showcaseId, project, itemIds }) =>
      run("reorder_project_items", async () => {
        const { client } = await connect();
        return reorderProjectItems(client, showcaseId, project, itemIds);
      }),
  );

  server.registerTool(
    "get_project_details",
    {
      title: "Get project details",
      description: `Reads the details a projects showcase defines for every project (facts like location, year, or square footage): each detail's key, label, type, unit, options, and whether it shows on cards, plus the version plan_project_details needs. Use it right before changing details or filling in values, since teammates edit them in the dashboard. Projects store values by key, and keys and option values never change.`,
      inputSchema: { showcaseId: idSchema("Projects showcase id from list_showcases.") },
      annotations: { title: "Get project details", readOnlyHint: true, openWorldHint: false },
    },
    ({ showcaseId }) =>
      run("get_project_details", async () => {
        const { client } = await connect();
        return projectDetailsResult(showcaseId, await client.get<ProjectDetailsSchemaResponse>(projectDetailsPath(showcaseId)));
      }),
  );

  server.registerTool(
    "plan_project_details",
    {
      title: "Plan project details",
      description: `Dry run: previews changing a projects showcase's details to the full list you pass and returns a plain-text summary, with changes that remove project values marked destructive. Use it whenever the user wants to add, rename, reorder, or remove project details; nothing is saved. ${PROJECT_DETAIL_EDIT_RULES.readFirst} ${PROJECT_DETAIL_EDIT_RULES.keepKeys} Show the summary to the user before apply_project_details.`,
      inputSchema: {
        showcaseId: idSchema("Projects showcase id from list_showcases."),
        fields: projectDetailFieldsSchema.describe(PROJECT_DETAILS_FIELDS_DESCRIPTION),
        expectedVersion: projectDetailsVersionSchema,
      },
      annotations: { title: "Plan project details", readOnlyHint: true, openWorldHint: false },
    },
    ({ showcaseId, fields, expectedVersion }) =>
      run("plan_project_details", async () => {
        const { client } = await connect();
        return changeProjectDetails(client, showcaseId, { fields, expectedVersion, dryRun: true });
      }),
  );

  server.registerTool(
    "apply_project_details",
    {
      title: "Apply project details",
      description: `Saves a change to a projects showcase's details: exactly the fields and expectedVersion you passed to plan_project_details. Use it once the user approved that plan. ${CONFIRM_FIRST} It's refused (SCHEMA_CHANGED) when someone changed the details since you read them, and (CONFIRMATION_REQUIRED) when it removes project values without confirmDestructive.`,
      inputSchema: {
        showcaseId: idSchema("Projects showcase id from list_showcases."),
        fields: projectDetailFieldsSchema.describe(PROJECT_DETAILS_FIELDS_DESCRIPTION),
        expectedVersion: projectDetailsVersionSchema,
        confirmDestructive: z.boolean().optional().describe("Only after the user explicitly agreed to every destructive change in the plan, e.g. true."),
      },
      annotations: { title: "Apply project details", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    ({ showcaseId, fields, expectedVersion, confirmDestructive }) =>
      run("apply_project_details", async () => {
        const { client } = await connect();
        return changeProjectDetails(client, showcaseId, { fields, expectedVersion, dryRun: false, confirmDestructive });
      }),
  );

  server.registerTool(
    "list_collections",
    {
      title: "List collections",
      description: `${COLLECTION_TOOL_DESCRIPTIONS.list_collections} Use it to find a collection id (a menu, inventory, team, or events) before reading or changing one, and to reuse an existing collection instead of creating a duplicate. Trashed collections only appear with trashed: true.`,
      inputSchema: {
        siteId: idSchema("Client site id (from list_sites)."),
        trashed: z.boolean().optional().describe("List trashed collections instead (restorable for 30 days), e.g. true."),
      },
      annotations: { title: "List collections", readOnlyHint: true, openWorldHint: false },
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
      description: `${COLLECTION_TOOL_DESCRIPTIONS.get_collection_schema} Use it right before any change to a collection or its items, since clients and teammates edit in the dashboard. It returns the schemaVersion that plan_collections needs to change an existing collection.`,
      inputSchema: { collectionId: idSchema("Collection id (from list_collections).") },
      annotations: { title: "Get collection schema", readOnlyHint: true, openWorldHint: false },
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
      description: `${COLLECTION_TOOL_DESCRIPTIONS.plan_collections} Use it whenever the user wants content their client can edit (a menu, inventory, events, team) or a field change; nothing is saved. Show the summary to the user before apply_collection_plan.`,
      inputSchema: {
        siteId: idSchema("Client site id (from list_sites)."),
        collections: collectionPlanSchema.describe(COLLECTIONS_PLAN_DESCRIPTION),
      },
      annotations: { title: "Plan collections", readOnlyHint: true, openWorldHint: false },
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
      description: `${COLLECTION_TOOL_DESCRIPTIONS.apply_collection_plan} Use it with exactly the collections you passed to plan_collections, once the user approved that plan. ${CONFIRM_FIRST}`,
      inputSchema: {
        siteId: idSchema("Client site id (from list_sites)."),
        collections: collectionPlanSchema.describe(COLLECTIONS_PLAN_DESCRIPTION),
        confirmDestructive: z.boolean().optional().describe("Only after the user explicitly agreed to every destructive change in the plan, e.g. true."),
      },
      annotations: { title: "Apply collection plan", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
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
      description: `${COLLECTION_TOOL_DESCRIPTIONS.add_collection_items} Use it to move a hard-coded list (a menu array in a component, rows from a CSV) into a collection. Run with dryRun: true (the default) first; saving (dryRun: false) needs explicit confirmation. Accepts up to ${MAX_COLLECTION_ITEMS_PER_CALL} items, sent in batches; retrying the same call doesn't duplicate items.`,
      inputSchema: {
        collectionId: idSchema("Collection id (from list_collections)."),
        items: z
          .array(collectionItemInputSchema)
          .min(1)
          .max(MAX_COLLECTION_ITEMS_PER_CALL)
          .describe("Items to add, e.g. [{ \"values\": { \"name\": \"Margherita\", \"price\": 14 } }]."),
        dryRun: z.boolean().optional().describe("Validate only (default true), e.g. false to save after the user confirmed."),
        mode: z
          .enum(["valid_only", "all_or_nothing"])
          .optional()
          .describe("valid_only (default) saves the valid items; all_or_nothing saves nothing if any item is invalid, e.g. \"all_or_nothing\"."),
      },
      annotations: { title: "Add collection items", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
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
      description: `${COLLECTION_TOOL_DESCRIPTIONS.list_collection_items} Use it to check what's already in a collection before importing, or to find items. Up to ${COLLECTION_ITEMS_PAGE_MAX} items per call; page with offset.`,
      inputSchema: {
        collectionId: idSchema("Collection id (from list_collections)."),
        q: z.string().max(200).optional().describe("Search titles and text fields, e.g. \"pizza\"."),
        status: z.enum(["draft", "published"]).optional().describe("Only drafts or only published items, e.g. \"published\"."),
        filters: collectionItemFiltersSchema.optional().describe("Field filters, e.g. [{ \"field\": \"category\", \"value\": \"mains\" }]."),
        sort: z.string().max(60).optional().describe("position (default), createdAt, updatedAt, publishedAt, title, or a field key; prefix - for descending, e.g. \"-updatedAt\"."),
        trashed: z.boolean().optional().describe("List trashed items instead, e.g. true."),
        limit: z.number().int().min(1).max(COLLECTION_ITEMS_PAGE_MAX).optional().describe(`Items per page (1–${COLLECTION_ITEMS_PAGE_MAX}), e.g. 50.`),
        offset: z.number().int().min(0).optional().describe("Items to skip, e.g. 50 for the second page of 50."),
      },
      annotations: { title: "List collection items", readOnlyHint: true, openWorldHint: false },
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
      description: `${COLLECTION_TOOL_DESCRIPTIONS.get_collection_code} Use it when wiring a page to read a collection, instead of guessing the response shape. Only published items reach the website.`,
      inputSchema: { collectionId: idSchema("Collection id (from list_collections).") },
      annotations: { title: "Get collection code", readOnlyHint: true, openWorldHint: false },
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
      description: `${COLLECTION_TOOL_DESCRIPTIONS.undo_collection_change} Use it when the user wants to revert a field or collection change. ${CONFIRM_FIRST}`,
      inputSchema: {
        collectionId: idSchema("Collection id (from list_collections)."),
        activityId: idSchema("Activity entry to undo; defaults to the most recent undoable one.").optional(),
      },
      annotations: { title: "Undo collection change", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
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
      description: `Lists feedback the client left on their website (comments on elements, text changes, general notes), newest first. Use it when the user asks to fix, review, or triage client feedback or change requests. Defaults to open and in progress. ${FEEDBACK_TOOL_GUIDANCE.textChanges} Use get_feedback for the full context of one request.`,
      inputSchema: {
        siteId: idSchema("Client site id (from list_sites)."),
        status: z
          .array(z.enum(FEEDBACK_STATUSES))
          .min(1)
          .max(FEEDBACK_STATUSES.length)
          .optional()
          .describe("Defaults to open and in_progress, e.g. [\"done\"]."),
        type: z.enum(FEEDBACK_REQUEST_TYPES).optional().describe("Only one kind of request, e.g. \"text_change\"."),
        page: z.string().trim().max(200).optional().describe("Only requests on pages whose path contains this, e.g. \"/menu\"."),
        limit: z.number().int().min(1).max(FEEDBACK_LIST_PAGE_MAX).optional().describe(`Requests per page (1–${FEEDBACK_LIST_PAGE_MAX}), e.g. 20.`),
        offset: z.number().int().min(0).optional().describe("Requests to skip, e.g. 20 for the second page of 20."),
      },
      annotations: { title: "List client feedback", readOnlyHint: true, openWorldHint: true },
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
      description: `Gets one feedback request with its full context: page URL, the clicked element (CSS selector, tag, nearby text, position), device and viewport, screenshot and photo URLs, and the thread. Use it before changing code for a request. ${FEEDBACK_TOOL_GUIDANCE.textChanges} ${FEEDBACK_TOOL_GUIDANCE.ambiguous} Screenshot and photo URLs are temporary; fetch them to look.`,
      inputSchema: { requestId: idSchema("Feedback request id (from list_feedback).") },
      annotations: { title: "Get client feedback", readOnlyHint: true, openWorldHint: true },
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
      description: `Replies in a feedback request's thread as the signed-in user; the client gets the reply by email. Use it to ask the client to clarify, or to tell them what changed. ${FEEDBACK_TOOL_GUIDANCE.ambiguous} Keep replies short and plain (no code). Safe to retry: the same reply isn't posted twice.`,
      inputSchema: {
        requestId: idSchema("Feedback request id (from list_feedback)."),
        message: z
          .string()
          .trim()
          .min(1)
          .max(FEEDBACK_MESSAGE_MAX_LENGTH)
          .describe("The reply, e.g. \"Should the new hours apply to both locations?\"."),
      },
      annotations: { title: "Reply to client feedback", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
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
      description: `Sets a feedback request to open, in_progress, done, or wont_do. Use it after fixing a request (done) or deciding not to (wont_do). ${FEEDBACK_TOOL_GUIDANCE.markDone} Marking done emails the client; only mark done once the fix is in the code (and deployed, if the user says so).`,
      inputSchema: {
        requestId: idSchema("Feedback request id (from list_feedback)."),
        status: z.enum(FEEDBACK_STATUSES).describe("New status, e.g. \"done\"."),
        resolutionNote: z
          .string()
          .trim()
          .max(FEEDBACK_RESOLUTION_NOTE_MAX_LENGTH)
          .optional()
          .describe("Short note for done or wont_do, e.g. \"Updated the opening hours on the contact page.\""),
      },
      annotations: { title: "Update feedback status", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
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
