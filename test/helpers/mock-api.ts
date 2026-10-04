import { createHash } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  MAX_GALLERY_PROJECTS,
  PROJECT_ERROR_CODES,
  applyProjectDetailChanges,
  availableProjectSlug,
  describeProjectDetailChanges,
  diffProjectDetailFields,
  isDestructiveProjectDetailChange,
  migrateProjectDetailValues,
  resolveProjectDetailFields,
  slugifyCategoryName,
  slugifyProjectTitle,
  type FeedbackAttachmentSummary,
  type FeedbackMessageSummary,
  type FeedbackRequestDetail,
  type GalleryCategorySummary,
  type GalleryDetail,
  type GalleryImageSummary,
  type GalleryProjectSummary,
  type PublicApiSite,
} from "@dropl/shared";

export const TEST_API_KEY = `dropl_test_${"a".repeat(43)}`;
export const ISSUED_API_KEY = `dropl_test_${"b".repeat(43)}`;

export interface RecordedRequest {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: any;
  query: URLSearchParams;
}

/** A menu collection with one undoable schema change; items without a `name` are invalid. */
export const MOCK_COLLECTION_ID = "col1";
const MOCK_COLLECTION_FIELDS = [
  { key: "name", label: "Name", type: "short_text", required: true, helpText: null, options: null, min: null, max: null, currency: null },
  { key: "price", label: "Price", type: "price", required: false, helpText: null, options: null, min: null, max: null, currency: "USD" },
];

export const MOCK_FEEDBACK_ID = "fb1";
const MOCK_SCREENSHOT: FeedbackAttachmentSummary = {
  id: "att1",
  purpose: "screenshot",
  status: "ready",
  previewUrl: "https://cdn.example.com/att1-preview.webp",
  largeUrl: "https://cdn.example.com/att1-large.webp",
  width: 1280,
  height: 720,
  fileName: "screenshot.png",
  createdAt: "2026-10-01T00:00:00.000Z",
};

function mockFeedbackRequest(): FeedbackRequestDetail {
  return {
    id: MOCK_FEEDBACK_ID,
    number: 7,
    site: { id: "site1", name: "Acme" },
    type: "text_change",
    imageAction: null,
    status: "open",
    message: null,
    pageUrl: "https://acme.example.com/contact",
    pagePath: "/contact",
    pageTitle: "Contact",
    currentText: "Open 9-5",
    requestedText: "Open 8-6",
    requester: { userId: "client1", name: "Cleo Client", isTeam: false },
    deviceType: "mobile",
    screenshot: MOCK_SCREENSHOT,
    replyCount: 0,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    lastActivityAt: "2026-10-01T00:00:00.000Z",
    element: {
      selector: "main > p:nth-of-type(2)",
      tagName: "p",
      textHint: "Open 9-5",
      rect: { x: 10, y: 20, width: 300, height: 24 },
      documentRect: { x: 10, y: 820, width: 300, height: 24 },
      imageSrc: null,
    },
    context: {
      deviceType: "mobile",
      browser: "Safari 18",
      os: "iOS 18",
      viewport: { width: 390, height: 844 },
      screen: { width: 390, height: 844 },
      devicePixelRatio: 3,
      scroll: { x: 0, y: 800 },
      language: "en-US",
      userAgent: null,
    },
    resolutionNote: null,
    resolvedAt: null,
    attachments: [MOCK_SCREENSHOT],
    messages: [],
    allowedStatuses: ["open", "in_progress", "done", "wont_do"],
  };
}

export interface StoragePutRecord {
  path: string;
  bytes: number;
  contentType: string | undefined;
  authorization: string | undefined;
}

interface Fault {
  method: string;
  pattern: RegExp;
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  remaining: number;
}

interface VideoSession {
  id: string;
  siteId: string;
  videoId: string;
  publicId: string;
  sizeBytes: number;
  partSizeBytes: number;
  partCount: number;
  uploadedParts: Map<number, number>;
  status: "pending" | "completed" | "aborted" | "expired";
}

export type DeviceStep = "pending" | "slow_down" | "success" | "denied" | "expired";

let sequence = 0;
function nextId(prefix: string): string {
  sequence += 1;
  return `${prefix}${sequence.toString(36).padStart(6, "0")}`;
}

function photoItem(id: string, fileName: string, position: number): GalleryImageSummary {
  return {
    id,
    kind: "photo",
    status: "uploading",
    failureReason: null,
    position,
    altText: null,
    width: null,
    height: null,
    placeholderColor: null,
    previewUrl: null,
    sourceFileName: fileName,
    categoryIds: [],
    video: null,
    projectId: null,
    createdAt: new Date().toISOString(),
  };
}

type MockShowcase = GalleryDetail & { siteId: string };

const apiError = (status: number, code: string, message: string): [number, unknown] => [status, { error: { code, message } }];

/** Just enough of the public API v1 contract, plus a fake storage endpoint, for the MCP tests. */
export class MockDroplApi {
  private server: http.Server | null = null;
  origin = "";
  readonly requests: RecordedRequest[] = [];
  readonly storagePuts: StoragePutRecord[] = [];
  private readonly faults: Fault[] = [];
  private readonly idempotency = new Map<string, { bodyHash: string; status: number; body: unknown }>();
  readonly sites: PublicApiSite[] = [{ id: "site1", name: "Acme", isDefault: true, domains: [], canEdit: true }];
  readonly showcases = new Map<string, MockShowcase>();
  readonly sessions = new Map<string, VideoSession>();
  readonly videos = new Map<string, { id: string; publicId: string; title: string; deletedAt: string | null }>();
  private readonly photoBytes = new Map<string, number>();
  readonly collectionItems: { values: Record<string, unknown>; status: string }[] = [];
  collectionActivityUndoable = true;
  readonly feedbackRequest = mockFeedbackRequest();
  partSizeBytes = 1024;
  deviceScript: DeviceStep[] = ["success"];
  deviceInterval = 5;
  deviceExpiresIn = 600;

  get baseUrl(): string {
    return `${this.origin}/api`;
  }

  async start(): Promise<void> {
    this.server = http.createServer((request, response) => void this.handle(request, response));
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    this.origin = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  /** The next `times` matching requests (API or storage) get `status`. */
  fail(method: string, pattern: RegExp, status: number, times = 1, body?: unknown, headers?: Record<string, string>): void {
    this.faults.push({ method, pattern, status, body, headers, remaining: times });
  }

  addShowcase(siteId = "site1", overrides: Partial<GalleryDetail> = {}): GalleryDetail {
    const id = nextId("sc");
    const showcase: MockShowcase = {
      id,
      publicId: `pub${id}`,
      title: "Portfolio",
      layout: "grid",
      readyImageCount: 0,
      itemCount: 0,
      videoCount: 0,
      coverUrl: null,
      isPrivate: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      deletedAt: null,
      workspaceId: siteId,
      purgeAfter: null,
      gridFit: "cover",
      showCategoryFilters: false,
      pageSize: 9,
      categories: [],
      images: [],
      type: "gallery",
      projectCount: 0,
      projectDetailFields: [],
      projectDetailsVersion: 1,
      projects: [],
      siteId,
      ...overrides,
    };
    this.showcases.set(id, showcase);
    return showcase;
  }

  /** Appends a project the way `POST .../projects` does. */
  addProject(showcase: GalleryDetail, overrides: Partial<GalleryProjectSummary> & { title: string }): GalleryProjectSummary {
    const slug = overrides.slug ?? availableProjectSlug(slugifyProjectTitle(overrides.title), new Set(showcase.projects.map((project) => project.slug)));
    const project: GalleryProjectSummary = {
      id: nextId("prj"),
      subtitle: null,
      description: null,
      coverImageId: null,
      coverUrl: null,
      position: showcase.projects.length,
      details: {},
      categoryIds: [],
      itemCount: 0,
      readyItemCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...overrides,
      slug,
    };
    showcase.projects.push(project);
    showcase.projectCount = showcase.projects.length;
    return project;
  }

  private projectItems(showcase: GalleryDetail, projectId: string): GalleryImageSummary[] {
    return showcase.images.filter((item) => item.projectId === projectId).sort((left, right) => left.position - right.position);
  }

  private refreshProjectCounts(showcase: GalleryDetail): void {
    for (const project of showcase.projects) {
      const items = this.projectItems(showcase, project.id);
      project.itemCount = items.length;
      project.readyItemCount = items.filter((item) => item.status === "ready").length;
    }
  }

  private projectList(showcase: MockShowcase) {
    this.refreshProjectCounts(showcase);
    return {
      showcaseId: showcase.id,
      type: showcase.type,
      detailFields: showcase.projectDetailFields,
      detailsVersion: showcase.projectDetailsVersion,
      projects: showcase.projects.map((project) => ({ ...project, items: this.projectItems(showcase, project.id) })),
    };
  }

  /** Null when the item may be added; otherwise the error response for its `projectId`. */
  private checkItemProject(showcase: GalleryDetail, projectId: string | undefined): [number, unknown] | null {
    if (showcase.type === "projects" && !projectId) return apiError(400, PROJECT_ERROR_CODES.projectRequired, "Items in a projects showcase need a projectId.");
    if (showcase.type !== "projects" && projectId) return apiError(400, PROJECT_ERROR_CODES.notProjectsShowcase, "This showcase has no projects.");
    if (projectId && !showcase.projects.some((project) => project.id === projectId)) return apiError(404, PROJECT_ERROR_CODES.projectNotFound, "Project not found.");
    return null;
  }

  requestsTo(method: string, pattern: RegExp): RecordedRequest[] {
    return this.requests.filter((request) => request.method === method && pattern.test(request.path));
  }

  private takeFault(method: string, path: string): Fault | null {
    const fault = this.faults.find((candidate) => candidate.remaining > 0 && candidate.method === method && candidate.pattern.test(path));
    if (!fault) return null;
    fault.remaining -= 1;
    return fault;
  }

  private async handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks);
    const url = new URL(request.url ?? "/", this.origin);
    const method = request.method ?? "GET";

    if (url.pathname.startsWith("/storage/")) return this.handleStorage(method, url.pathname, request, raw, response);

    let body: any = null;
    if (raw.length > 0) body = JSON.parse(raw.toString("utf8"));
    const path = url.pathname.replace(/^\/api/, "");
    this.requests.push({ method, path, headers: request.headers, body, query: url.searchParams });

    const send = (status: number, payload: unknown, headers: Record<string, string> = {}) => {
      response.writeHead(status, { "content-type": "application/json", ...headers });
      response.end(payload === undefined ? "" : JSON.stringify(payload));
    };
    const fault = this.takeFault(method, path);
    if (fault) return send(fault.status, fault.body ?? { error: { code: `HTTP_${fault.status}`, message: `Injected ${fault.status}` } }, fault.headers);

    const isPublic = path.startsWith("/v1/auth/device");
    if (!isPublic && request.headers.authorization !== `Bearer ${TEST_API_KEY}` && request.headers.authorization !== `Bearer ${ISSUED_API_KEY}`) {
      return send(401, { error: { code: "INVALID_API_KEY", message: "This API key isn't valid." } });
    }

    const idempotencyKey = request.headers["idempotency-key"] as string | undefined;
    const cacheKey = idempotencyKey ? `${method} ${path} ${idempotencyKey}` : null;
    const bodyHash = createHash("sha256").update(raw).digest("hex");
    if (cacheKey) {
      const cached = this.idempotency.get(cacheKey);
      if (cached) {
        if (cached.bodyHash !== bodyHash) {
          return send(422, { error: { code: "IDEMPOTENCY_KEY_REUSED", message: "This Idempotency-Key was used with a different request." } });
        }
        return send(cached.status, cached.body, { "idempotent-replayed": "true" });
      }
    }

    const [status, payload] = this.route(method, path, url, body);
    if (cacheKey && status < 300) this.idempotency.set(cacheKey, { bodyHash, status, body: payload });
    send(status, payload);
  }

  private handleStorage(method: string, path: string, request: http.IncomingMessage, raw: Buffer, response: http.ServerResponse): void {
    const fault = this.takeFault(method, path);
    if (fault) {
      response.writeHead(fault.status);
      response.end();
      return;
    }
    const declaredLength = Number(request.headers["content-length"]);
    if (method !== "PUT" || declaredLength !== raw.length || request.headers["transfer-encoding"]) {
      response.writeHead(400);
      response.end();
      return;
    }
    this.storagePuts.push({ path, bytes: raw.length, contentType: request.headers["content-type"], authorization: request.headers.authorization });
    const photo = /^\/storage\/photo\/([^/]+)$/.exec(path);
    if (photo) this.photoBytes.set(photo[1]!, raw.length);
    const part = /^\/storage\/part\/([^/]+)\/(\d+)$/.exec(path);
    if (part) {
      const session = this.sessions.get(part[1]!);
      const partNumber = Number(part[2]);
      if (!session) {
        response.writeHead(404);
        response.end();
        return;
      }
      const expected = partNumber < session.partCount ? session.partSizeBytes : session.sizeBytes - session.partSizeBytes * (session.partCount - 1);
      if (raw.length !== expected) {
        response.writeHead(400);
        response.end();
        return;
      }
      session.uploadedParts.set(partNumber, raw.length);
    }
    response.writeHead(200);
    response.end();
  }

  private route(method: string, path: string, url: URL, body: any): [number, unknown] {
    const notFound: [number, unknown] = [404, { error: { code: "NOT_FOUND", message: "Not found." } }];
    let match: RegExpExecArray | null;

    if (method === "POST" && path === "/v1/auth/device") {
      return [200, {
        device_code: "device-code-1",
        user_code: "BCDF-GHJK",
        verification_uri: `${this.origin}/connect`,
        verification_uri_complete: `${this.origin}/connect?code=BCDF-GHJK`,
        expires_in: this.deviceExpiresIn,
        interval: this.deviceInterval,
      }];
    }
    if (method === "POST" && path === "/v1/auth/device/token") {
      const step = this.deviceScript.shift() ?? "pending";
      const oauthError = (code: string) => [400, { error: code, error_description: `Device ${code}` }] as [number, unknown];
      if (step === "pending") return oauthError("authorization_pending");
      if (step === "slow_down") return oauthError("slow_down");
      if (step === "denied") return oauthError("access_denied");
      if (step === "expired") return oauthError("expired_token");
      return [200, {
        access_token: ISSUED_API_KEY,
        token_type: "Bearer",
        api_key: { id: "key1", name: "Cursor on laptop", prefix: ISSUED_API_KEY.slice(0, 15), scopes: ["sites:read"], siteIds: null },
        organization: { id: "org1", name: "Acme Studio" },
      }];
    }
    if (method === "GET" && path === "/v1/me") {
      return [200, {
        organization: { id: "org1", name: "Acme Studio", slug: "acme" },
        user: { id: "user1", email: "owner@example.com", name: "Owner" },
        role: "OWNER",
        apiKey: { id: "key1", name: "Test key", prefix: TEST_API_KEY.slice(0, 15), scopes: ["sites:read"], siteIds: null, expiresAt: null },
        webAppUrl: this.origin,
      }];
    }
    if (method === "GET" && path === "/v1/sites") return [200, { sites: this.sites, allowance: { used: this.sites.length, limit: 5 } }];
    if (method === "POST" && path === "/v1/sites") {
      const site: PublicApiSite = { id: nextId("site"), name: body.name, isDefault: false, domains: body.domain ? [body.domain] : [], canEdit: true };
      this.sites.push(site);
      return [201, site];
    }
    if ((match = /^\/v1\/sites\/([^/]+)\/showcases$/.exec(path))) {
      if (method === "POST") {
        const { siteId: _siteId, ...showcase } = this.addShowcase(match[1]!, body) as GalleryDetail & { siteId: string };
        return [201, showcase];
      }
      const galleries = [...this.showcases.values()].filter((showcase) => showcase.siteId === match![1]);
      return [200, { galleries, nextCursor: null }];
    }
    if ((match = /^\/v1\/showcases\/([^/]+)(\/.*)?$/.exec(path))) {
      const showcase = this.showcases.get(match[1]!);
      if (!showcase) return notFound;
      const rest = match[2] ?? "";
      if (rest === "" && method === "GET") {
        this.refreshProjectCounts(showcase);
        return [200, showcase];
      }
      if (rest === "" && method === "PATCH") {
        Object.assign(showcase, body);
        return [200, showcase];
      }
      if (rest === "/categories" && method === "POST") {
        const slug = body.slug ?? slugifyCategoryName(body.name);
        if (showcase.categories.some((category) => category.slug === slug)) {
          return [409, { error: { code: "CATEGORY_EXISTS", message: "A category with this slug exists." } }];
        }
        const category: GalleryCategorySummary = { id: nextId("cat"), name: body.name, slug, position: showcase.categories.length, itemCount: 0, projectCount: 0 };
        showcase.categories.push(category);
        return [201, category];
      }
      if (rest === "/items/categories" && method === "POST") {
        for (const item of showcase.images.filter((image) => body.imageIds.includes(image.id))) {
          const ids = new Set(item.categoryIds);
          for (const id of body.addCategoryIds ?? []) ids.add(id);
          for (const id of body.removeCategoryIds ?? []) ids.delete(id);
          item.categoryIds = [...ids];
        }
        for (const category of showcase.categories) category.itemCount = showcase.images.filter((image) => image.categoryIds.includes(category.id)).length;
        return [200, { updated: body.imageIds.length }];
      }
      if (rest === "/items" && method === "PATCH") {
        const changes: { id: string; altText?: string | null; addCategoryIds?: string[]; removeCategoryIds?: string[] }[] = body.items;
        const items = changes.map((change) => showcase.images.find((image) => image.id === change.id));
        if (items.some((item) => !item)) return [404, { error: { code: "IMAGE_NOT_FOUND", message: "Item not found." } }];
        const categoryIds = new Set(showcase.categories.map((category) => category.id));
        if (changes.some((change) => [...(change.addCategoryIds ?? []), ...(change.removeCategoryIds ?? [])].some((id) => !categoryIds.has(id)))) {
          return [404, { error: { code: "CATEGORY_NOT_FOUND", message: "Category not found." } }];
        }
        changes.forEach((change, index) => {
          const item = items[index]!;
          if (change.altText !== undefined) item.altText = change.altText?.trim() || null;
          const ids = new Set(item.categoryIds);
          for (const id of change.addCategoryIds ?? []) ids.add(id);
          for (const id of change.removeCategoryIds ?? []) ids.delete(id);
          item.categoryIds = [...ids];
        });
        for (const category of showcase.categories) category.itemCount = showcase.images.filter((image) => image.categoryIds.includes(category.id)).length;
        return [200, { items }];
      }
      if (rest === "/videos" && method === "POST") {
        const refused = this.checkItemProject(showcase, body.projectId);
        if (refused) return refused;
        for (const videoId of body.videoIds) {
          const video = this.videos.get(videoId);
          if (!video || showcase.images.some((item) => item.video?.id === videoId)) continue;
          showcase.images.push({
            ...photoItem(nextId("item"), video.title, showcase.images.length),
            kind: "video",
            status: "ready",
            video: { id: video.id, publicId: video.publicId, title: video.title, durationMs: null, availability: "processing" },
            projectId: body.projectId ?? null,
          });
        }
        return [200, showcase];
      }
      if (rest.startsWith("/project")) return this.routeProjects(method, rest, showcase, body);
      if (rest === "/photos/uploads" && method === "POST") {
        const refused = this.checkItemProject(showcase, body.projectId);
        if (refused) return refused;
        const uploads = body.files.map((file: { fileName: string; contentType: string; altText?: string | null }) => {
          const imageId = nextId("img");
          showcase.images.push({ ...photoItem(imageId, file.fileName, showcase.images.length), altText: file.altText || null, projectId: body.projectId ?? null });
          return { imageId, uploadUrl: `${this.origin}/storage/photo/${imageId}`, headers: { "Content-Type": file.contentType } };
        });
        return [201, { uploads, expiresAt: new Date(Date.now() + 3_600_000).toISOString() }];
      }
      if (rest === "/photos/uploads/complete" && method === "POST") {
        const images = showcase.images.filter((image) => body.imageIds.includes(image.id));
        for (const image of images) if (this.photoBytes.has(image.id)) image.status = "processing";
        return [200, { images }];
      }
      if (rest === "/embed" && method === "GET") {
        const projectUrl = url.searchParams.get("projectUrl");
        const html = (attributes = "") => `<div data-dropl-showcase="${showcase.publicId}"${attributes}></div>\n<script src="${this.origin}/embed/showcase.js" async></script>`;
        const isProjects = showcase.type === "projects";
        return [200, {
          showcaseId: showcase.id,
          publicId: showcase.publicId,
          type: showcase.type,
          html: html(isProjects && projectUrl ? ` data-project-url="${projectUrl}"` : ""),
          categories: showcase.categories.map((category) => ({ id: category.id, name: category.name, slug: category.slug, html: html(` data-category="${category.slug}"`) })),
          ...(isProjects && {
            projects: showcase.projects.map((project) => ({ id: project.id, title: project.title, slug: project.slug, html: html(` data-project="${project.slug}"`) })),
          }),
          notes: ["Photos still processing appear once ready."],
        }];
      }
      return notFound;
    }
    if ((match = /^\/v1\/sites\/([^/]+)\/videos\/uploads$/.exec(path)) && method === "POST") {
      const id = nextId("up");
      const videoId = nextId("vid");
      const session: VideoSession = {
        id,
        siteId: match[1]!,
        videoId,
        publicId: `p${videoId}`,
        sizeBytes: body.sizeBytes,
        partSizeBytes: this.partSizeBytes,
        partCount: Math.ceil(body.sizeBytes / this.partSizeBytes),
        uploadedParts: new Map(),
        status: "pending",
      };
      this.sessions.set(id, session);
      this.videos.set(videoId, { id: videoId, publicId: session.publicId, title: body.title, deletedAt: null });
      return [201, {
        uploadSessionId: id,
        videoId,
        publicId: session.publicId,
        partSizeBytes: session.partSizeBytes,
        partCount: session.partCount,
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      }];
    }
    if ((match = /^\/v1\/uploads\/([^/]+)(\/parts|\/complete)?$/.exec(path))) {
      const session = this.sessions.get(match[1]!);
      if (!session) return notFound;
      if (match[2] === "/parts" && method === "POST") {
        return [200, {
          parts: body.partNumbers.map((partNumber: number) => ({ partNumber, url: `${this.origin}/storage/part/${session.id}/${partNumber}` })),
          urlsExpireAt: new Date(Date.now() + 3_600_000).toISOString(),
        }];
      }
      if (match[2] === "/complete" && method === "POST") {
        if (session.uploadedParts.size !== session.partCount) return [400, { error: { code: "UPLOAD_INCOMPLETE", message: "Some parts are missing." } }];
        session.status = "completed";
        return [200, { videoId: session.videoId, publicId: session.publicId, status: "processing" }];
      }
      if (!match[2] && method === "GET") {
        return [200, {
          uploadSessionId: session.id,
          videoId: session.videoId,
          status: session.status,
          partSizeBytes: session.partSizeBytes,
          partCount: session.partCount,
          uploadedPartNumbers: session.status === "pending" ? [...session.uploadedParts.keys()].sort((a, b) => a - b) : [],
          expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        }];
      }
      return notFound;
    }
    if ((match = /^\/v1\/videos\/([^/]+)(\/embed)?$/.exec(path)) && method === "GET") {
      const video = this.videos.get(match[1]!);
      if (!video) return notFound;
      if (match[2]) {
        return [200, {
          videoId: video.id,
          publicId: video.publicId,
          html: `<div data-dropl-video="${video.publicId}"></div>\n<script src="${this.origin}/embed/player.js" async></script>`,
          watchUrl: null,
          embeddable: false,
          notes: ["The video is still processing."],
        }];
      }
      return [200, { ...video, status: "processing" }];
    }
    if (method === "GET" && path === "/v1/usage") {
      return [200, {
        periodStart: "2026-10-01T00:00:00.000Z",
        periodEnd: "2026-11-01T00:00:00.000Z",
        isTrialPeriod: false,
        storage: { usedBytes: 1_000_000, limitBytes: 10_000_000 },
        bandwidth: { usedBytes: 0, limitBytes: 100_000_000 },
        bandwidthTracked: true,
        uploadedBytes: 0,
        encodedSeconds: 0,
        playbackSuspended: false,
        uploadsSuspended: false,
        suspensionReason: null,
        days: [],
        workspaces: [],
        updatedAt: null,
      }];
    }
    return this.routeCollections(method, path, body) ?? this.routeFeedback(method, path, body) ?? notFound;
  }

  /** `/v1/showcases/:id/projects…` and `/v1/showcases/:id/project-details`, following the projects contract. */
  private routeProjects(method: string, rest: string, showcase: MockShowcase, body: any): [number, unknown] {
    const notFound = apiError(404, "NOT_FOUND", "Not found.");
    if (rest === "/project-details") {
      if (method === "GET") return [200, { fields: showcase.projectDetailFields, version: showcase.projectDetailsVersion }];
      if (method !== "PUT") return notFound;
      if (body.expectedVersion !== showcase.projectDetailsVersion) return apiError(409, PROJECT_ERROR_CODES.schemaChanged, "The project details changed since you read them.");
      const { fields, issues } = resolveProjectDetailFields(showcase.projectDetailFields, body.fields);
      if (issues.length > 0) return apiError(400, PROJECT_ERROR_CODES.invalidDetails, issues.map((issue) => issue.message).join(" "));
      const changes = diffProjectDetailFields(showcase.projectDetailFields, fields, showcase.projects.map((project) => project.details));
      const summary = describeProjectDetailChanges(changes);
      if (body.dryRun) return [200, { applied: false, fields, version: showcase.projectDetailsVersion, changes, summary }];
      if (isDestructiveProjectDetailChange(changes) && !body.confirmDestructive) {
        return apiError(409, PROJECT_ERROR_CODES.confirmationRequired, "This change removes values projects have.");
      }
      showcase.projectDetailFields = fields;
      showcase.projectDetailsVersion += 1;
      for (const project of showcase.projects) project.details = migrateProjectDetailValues(fields, project.details);
      return [200, { applied: true, fields, version: showcase.projectDetailsVersion, changes, summary }];
    }

    if (showcase.type !== "projects") return apiError(400, PROJECT_ERROR_CODES.notProjectsShowcase, "This showcase has no projects.");
    if (rest === "/projects" && method === "GET") return [200, this.projectList(showcase)];
    if (rest === "/projects" && method === "POST") {
      if (showcase.projects.length >= MAX_GALLERY_PROJECTS) return apiError(409, PROJECT_ERROR_CODES.tooManyProjects, "This showcase has the most projects it can hold.");
      if (body.slug && showcase.projects.some((project) => project.slug === body.slug)) return apiError(409, PROJECT_ERROR_CODES.projectSlugTaken, "Another project uses this slug.");
      const details = applyProjectDetailChanges(showcase.projectDetailFields, {}, body.details ?? {});
      if (!details.ok) return apiError(400, PROJECT_ERROR_CODES.invalidDetails, details.issues.map((issue) => issue.message).join(" "));
      const project = this.addProject(showcase, {
        title: body.title,
        subtitle: body.subtitle ?? null,
        description: body.description ?? null,
        ...(body.slug && { slug: body.slug }),
        details: details.values,
        categoryIds: body.categoryIds ?? [],
      });
      return [201, project];
    }
    if (rest === "/projects/order" && method === "PUT") {
      const currentIds = showcase.projects.map((project) => project.id).sort();
      if ([...body.projectIds].sort().join() !== currentIds.join()) return apiError(400, "INVALID_ORDER", "List every project exactly once.");
      showcase.projects.sort((left, right) => body.projectIds.indexOf(left.id) - body.projectIds.indexOf(right.id));
      showcase.projects.forEach((project, index) => (project.position = index));
      return [200, this.projectList(showcase)];
    }
    const projectMatch = /^\/projects\/([^/]+)(\/items\/order)?$/.exec(rest);
    const project = projectMatch ? showcase.projects.find((candidate) => candidate.id === projectMatch[1]) : undefined;
    if (!projectMatch) return notFound;
    if (!project) return apiError(404, PROJECT_ERROR_CODES.projectNotFound, "Project not found.");
    if (projectMatch[2] && method === "PUT") {
      const items = this.projectItems(showcase, project.id);
      if ([...body.imageIds].sort().join() !== items.map((item) => item.id).sort().join()) return apiError(400, "INVALID_ORDER", "List every item of the project exactly once.");
      const positions = items.map((item) => item.position).sort((left, right) => left - right);
      body.imageIds.forEach((id: string, index: number) => (items.find((item) => item.id === id)!.position = positions[index]!));
      return [200, { ...project, items: this.projectItems(showcase, project.id) }];
    }
    if (!projectMatch[2] && method === "PATCH") {
      if (body.slug && showcase.projects.some((candidate) => candidate.id !== project.id && candidate.slug === body.slug)) {
        return apiError(409, PROJECT_ERROR_CODES.projectSlugTaken, "Another project uses this slug.");
      }
      const { details: detailChanges, ...changes } = body;
      if (detailChanges) {
        const details = applyProjectDetailChanges(showcase.projectDetailFields, project.details, detailChanges);
        if (!details.ok) return apiError(400, PROJECT_ERROR_CODES.invalidDetails, details.issues.map((issue) => issue.message).join(" "));
        project.details = details.values;
      }
      Object.assign(project, changes, { updatedAt: new Date().toISOString() });
      this.refreshProjectCounts(showcase);
      return [200, project];
    }
    return notFound;
  }

  private routeFeedback(method: string, path: string, body: any): [number, unknown] | null {
    if (method === "GET" && path === "/v1/sites/site1/feedback") return [200, { requests: [this.feedbackRequest], total: 3 }];
    const feedbackMatch = /^\/v1\/feedback\/([^/]+)(\/replies)?$/.exec(path);
    if (!feedbackMatch) return null;
    if (feedbackMatch[1] !== MOCK_FEEDBACK_ID) return [404, { error: { code: "NOT_FOUND", message: "Feedback request not found." } }];
    const request = this.feedbackRequest;
    if (method === "GET" && !feedbackMatch[2]) return [200, request];
    if (method === "POST" && feedbackMatch[2]) {
      const message: FeedbackMessageSummary = {
        id: nextId("msg"),
        kind: "reply",
        author: { userId: "user1", name: "Owner", isTeam: true },
        body: body.message,
        statusFrom: null,
        statusTo: null,
        attachments: [],
        createdAt: "2026-10-02T00:00:00.000Z",
      };
      request.messages.push(message);
      return [201, message];
    }
    if (method === "PATCH" && !feedbackMatch[2]) {
      request.status = body.status;
      request.resolutionNote = body.resolutionNote ?? null;
      return [200, request];
    }
    return null;
  }

  private routeCollections(method: string, path: string, body: any): [number, unknown] | null {
    const limits = { itemsUsed: this.collectionItems.length, itemLimit: 1000 };
    if (method === "GET" && path === "/v1/sites/site1/collections") {
      return [200, {
        collections: [{ id: MOCK_COLLECTION_ID, name: "Menu", slug: "menu", visibility: "public", itemCount: this.collectionItems.length, publishedItemCount: 0, deletedAt: null, lastPublicReadAt: null }],
        limits,
        canEditSchema: true,
      }];
    }
    if (method === "POST" && path === "/v1/sites/site1/collections/plan") {
      const destructive = body.collections.some((entry: any) => entry.fields && !entry.fields.some((field: any) => field.key === "price"));
      if (!body.dryRun && destructive && !body.confirmDestructive) {
        return [409, { error: { code: "CONFIRMATION_REQUIRED", message: "This change removes data." } }];
      }
      return [200, {
        applied: !body.dryRun,
        destructive,
        summary: destructive ? `Menu: remove field "Price" (3 items lose their value).` : "Menu: no changes.",
        results: [{ slug: "menu", name: "Menu", action: destructive ? "update" : "unchanged", collectionId: MOCK_COLLECTION_ID, changes: [], destructive, schemaVersion: 3, message: null }],
      }];
    }
    const collectionMatch = /^\/v1\/collections\/([^/]+)(\/.*)?$/.exec(path);
    if (!collectionMatch || collectionMatch[1] !== MOCK_COLLECTION_ID) return null;
    const rest = collectionMatch[2] ?? "";
    if (method === "GET" && rest === "/schema") {
      return [200, {
        collectionId: MOCK_COLLECTION_ID,
        slug: "menu",
        name: "Menu",
        schemaVersion: 3,
        titleFieldKey: "name",
        fields: MOCK_COLLECTION_FIELDS,
        timezone: "America/Chicago",
        typescript: "export interface MenuItem {}",
        publicItemsUrl: `${this.origin}/api/v1/public/collections/pubcol1/items`,
      }];
    }
    if (method === "POST" && rest === "/items/bulk") {
      const errors = body.items.flatMap((item: any, index: number) => (typeof item.values.name === "string" && item.values.name ? [] : [{ index, errors: { name: "Name is required." } }]));
      const valid = body.items.filter((_item: any, index: number) => !errors.some((error: any) => error.index === index));
      const save = !body.dryRun && !(body.mode === "all_or_nothing" && errors.length > 0);
      const created = save ? valid.map((item: any) => ({ id: nextId("it"), values: item.values, status: item.status ?? "published" })) : [];
      if (save) this.collectionItems.push(...created);
      return [200, { created, errors, dryRun: Boolean(body.dryRun) }];
    }
    if (method === "GET" && rest === "/items") {
      const items = this.collectionItems.map((item: any, position) => ({ ...item, slug: `item-${position}`, title: String(item.values.name), position, updatedAt: "2026-10-01T00:00:00.000Z", deletedAt: null }));
      return [200, { items, total: items.length, limit: 50, offset: 0, media: {} }];
    }
    const activity = [
      { id: "act2", action: "item.created", summary: "Added an item", actor: { type: "user", name: "Ada" }, createdAt: "2026-10-02T00:00:00.000Z", undoable: false, undoneAt: null },
      { id: "act1", action: "schema.changed", summary: `Renamed "Cost" to "Price"`, actor: { type: "user", name: "Ada" }, createdAt: "2026-10-01T00:00:00.000Z", undoable: this.collectionActivityUndoable, undoneAt: null },
    ];
    if (method === "GET" && rest === "/activity") return [200, { activity }];
    const undoMatch = /^\/activity\/([^/]+)\/undo$/.exec(rest);
    if (method === "POST" && undoMatch) {
      if (undoMatch[1] !== "act1" || !this.collectionActivityUndoable) return [409, { error: { code: "UNDO_NOT_AVAILABLE", message: "This change can't be undone." } }];
      this.collectionActivityUndoable = false;
      return [200, { changes: [{ kind: "field_renamed", fieldKey: "price", description: `Rename "Price" to "Cost"`, destructive: false, affectedItemCount: 0 }], destructive: false, applied: true, collection: { schemaVersion: 4 } }];
    }
    return null;
  }
}
