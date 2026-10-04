import {
  MAX_PROJECT_CARD_DETAILS,
  MAX_PROJECT_DETAIL_FIELDS,
  PROJECT_DETAIL_KEY_MAX_LENGTH,
  PROJECT_DETAIL_KEY_PATTERN,
  PROJECT_DETAIL_LABEL_MAX_LENGTH,
  PROJECT_DETAIL_MAX_OPTIONS,
  PROJECT_DETAIL_OPTION_LABEL_MAX_LENGTH,
  PROJECT_DETAIL_OPTION_VALUE_MAX_LENGTH,
  PROJECT_DETAIL_TEXT_MAX_LENGTH,
  PROJECT_DETAIL_TYPE_LABELS,
  PROJECT_DETAIL_TYPES,
  PROJECT_DETAIL_UNIT_MAX_LENGTH,
  collapseWhitespace,
  describeProjectDetailChanges,
  formatProjectDetailValue,
  isDestructiveProjectDetailChange,
  normalizeProjectDetailValue,
  projectExcerpt,
  slugifyProjectTitle,
  type CreateGalleryProjectRequest,
  type GalleryDetail,
  type GalleryProjectListResponse,
  type GalleryProjectSummary,
  type GalleryProjectWithItems,
  type ProjectDetailField,
  type ProjectDetailFieldInput,
  type ProjectDetailValue,
  type ProjectDetailValues,
  type ProjectDetailsSchemaResponse,
  type ReorderGalleryProjectItemsRequest,
  type ReorderGalleryProjectsRequest,
  type ShowcaseTypeCode,
  type UpdateGalleryProjectRequest,
  type UpdateProjectDetailFieldsRequest,
  type UpdateProjectDetailFieldsResponse,
} from "@dropl/shared";
import { z } from "zod";
import { pathSegment, type DroplApiClient } from "./api-client.js";
import { categoryKey, ensureCategories, normalizeCategoryName, showcasePath, type CategoryRef } from "./categories.js";
import { UserFacingError } from "./errors.js";
import { truncateList } from "./format.js";
import { deriveIdempotencyKey } from "./idempotency.js";
import { LIST_ITEMS_DEFAULT_LIMIT, itemView, matchCategory } from "./showcase-items.js";

export const LIST_PROJECTS_DEFAULT_LIMIT = 20;
/** Projects named in an error message; past this, list_projects pages through them. */
const MAX_PROJECTS_IN_MESSAGE = 20;
const MAX_LISTED_REORDERED_ITEMS = 50;
const MAX_UNKNOWN_IDS_IN_MESSAGE = 10;

/** Repeated in the server instructions and the details tools' descriptions. */
export const PROJECT_DETAIL_EDIT_RULES = {
  readFirst:
    "Always read the current details with get_project_details right before changing them: teammates edit them in the dashboard, so an earlier copy may be stale. Never revert or overwrite their edits.",
  keepKeys:
    "Send the full list in order: existing details with their key and option values exactly as read (only labels, units, and option labels can be renamed; keys and types never change), new details and options without a key or value. Leaving one out removes it.",
  confirm:
    "plan_project_details never saves: show its summary to the user and only call apply_project_details after their explicit confirmation, with confirmDestructive: true only after they agree to every change marked destructive.",
} as const;

/* Input schemas */

const detailOptionSchema = z.object({
  value: z
    .string()
    .trim()
    .max(PROJECT_DETAIL_OPTION_VALUE_MAX_LENGTH)
    .optional()
    .describe("Existing options: their current value exactly as read, e.g. \"custom-home\". New options: omit; it's derived from the label."),
  label: z.string().trim().min(1).max(PROJECT_DETAIL_OPTION_LABEL_MAX_LENGTH).describe("Shown on the website, e.g. \"Custom Home\"."),
});

export const projectDetailFieldSchema = z.object({
  key: z
    .string()
    .trim()
    .max(PROJECT_DETAIL_KEY_MAX_LENGTH)
    .regex(PROJECT_DETAIL_KEY_PATTERN)
    .optional()
    .describe("Existing details: always their current key (from get_project_details), e.g. \"square_footage\". New details: omit; it's derived from the label."),
  label: z.string().trim().min(1).max(PROJECT_DETAIL_LABEL_MAX_LENGTH).describe("Shown on project pages, e.g. \"Square footage\"."),
  type: z.enum(PROJECT_DETAIL_TYPES).describe("short_text, number, select, year, date, or link; an existing detail keeps its type, e.g. \"number\"."),
  unit: z
    .string()
    .trim()
    .min(1)
    .max(PROJECT_DETAIL_UNIT_MAX_LENGTH)
    .nullable()
    .optional()
    .describe("number only: shown after the value, which stays a plain number, e.g. \"sq ft\"."),
  options: z
    .array(detailOptionSchema)
    .min(1)
    .max(PROJECT_DETAIL_MAX_OPTIONS)
    .nullable()
    .optional()
    .describe("select only, in order, e.g. [{ \"label\": \"Custom Home\" }, { \"label\": \"Remodel\" }]."),
  showOnCard: z.boolean().optional().describe(`Also show it on the projects index cards (at most ${MAX_PROJECT_CARD_DETAILS} details), e.g. true.`),
});

export const projectDetailFieldsSchema = z.array(projectDetailFieldSchema).max(MAX_PROJECT_DETAIL_FIELDS);

export const projectDetailValuesSchema = z.record(
  z.string().max(PROJECT_DETAIL_KEY_MAX_LENGTH),
  z.union([z.string().max(PROJECT_DETAIL_TEXT_MAX_LENGTH), z.number().finite(), z.null()]),
);

/* Lookups */

export interface ProjectTarget {
  id: string;
  slug: string;
  title: string;
}

export function showcaseType(detail: Pick<GalleryDetail, "type">): ShowcaseTypeCode {
  return detail.type ?? "gallery";
}

function projectsOf(detail: GalleryDetail): GalleryProjectSummary[] {
  return detail.projects ?? [];
}

function projectTarget(project: GalleryProjectSummary): ProjectTarget {
  return { id: project.id, slug: project.slug, title: project.title };
}

function describeProjects(projects: readonly GalleryProjectSummary[]): string {
  if (projects.length === 0) return "it has none yet; add one with create_project";
  const listed = truncateList(projects, MAX_PROJECTS_IN_MESSAGE);
  const more = listed.omitted > 0 ? `, and ${listed.omitted} more (see list_projects)` : "";
  return `its projects: ${listed.items.map((project) => `${project.title} (${project.slug})`).join(", ")}${more}`;
}

export function requireProjectsShowcase(detail: GalleryDetail): void {
  if (showcaseType(detail) === "projects") return;
  throw new UserFacingError(
    `"${detail.title}" is a gallery showcase, not a projects showcase. For a portfolio, create one with create_showcase and type: "projects" (a showcase's type can only change while it's empty, in the Dropl dashboard).`,
  );
}

/** A project by id or slug, else by title (ignoring case and spacing), else by the slug its title would get. */
export function findProject<Project extends GalleryProjectSummary>(projects: readonly Project[], reference: string): Project {
  const wanted = collapseWhitespace(reference);
  const byIdOrSlug = projects.find((project) => project.id === wanted || project.slug === wanted);
  if (byIdOrSlug) return byIdOrSlug;
  const byTitle = projects.filter((project) => collapseWhitespace(project.title).toLowerCase() === wanted.toLowerCase());
  if (byTitle.length > 1) {
    throw new UserFacingError(`Several projects are titled "${reference}": ${byTitle.map((project) => project.slug).join(", ")}. Pass the slug or id instead.`);
  }
  const match = byTitle[0] ?? projects.find((project) => project.slug === slugifyProjectTitle(wanted));
  if (match) return match;
  throw new UserFacingError(`No project "${reference}" in this showcase; ${describeProjects(projects)}.`);
}

/**
 * Where uploads go: null for gallery showcases, the project for projects showcases (where every item needs one).
 * Item categories don't apply there: projects carry the categories.
 */
export function resolveUploadProject(detail: GalleryDetail, reference: string | undefined, usesCategories: boolean): ProjectTarget | null {
  const isProjects = showcaseType(detail) === "projects";
  if (!isProjects) {
    if (reference) throw new UserFacingError(`"${detail.title}" is a gallery showcase without projects; leave out project.`);
    return null;
  }
  if (!reference?.trim()) {
    throw new UserFacingError(
      `"${detail.title}" is a projects showcase: every photo and video belongs to a project. Pass project (its slug, title, or id); ${describeProjects(projectsOf(detail))}.`,
    );
  }
  if (usesCategories) {
    throw new UserFacingError(
      "In a projects showcase, categories belong to projects, not to photos or videos: leave out categories and categoryFromFolder, and set the project's categories with create_project or update_project.",
    );
  }
  return projectTarget(findProject(projectsOf(detail), reference));
}

/* Views */

function detailList(fields: readonly ProjectDetailField[], values: ProjectDetailValues) {
  return fields.flatMap((field) => {
    const value = values[field.key];
    return value === undefined ? [] : [{ key: field.key, label: field.label, value, display: formatProjectDetailValue(field, value) }];
  });
}

function fieldView(field: ProjectDetailField) {
  return {
    key: field.key,
    label: field.label,
    type: field.type,
    ...(field.unit && { unit: field.unit }),
    ...(field.options && { options: field.options }),
    ...(field.showOnCard && { showOnCard: true }),
  };
}

/** One project with everything an agent edits: full description and labeled details. */
export function projectView(project: GalleryProjectSummary, fields: readonly ProjectDetailField[], categoryNames: Map<string, string>) {
  return {
    id: project.id,
    slug: project.slug,
    title: project.title,
    subtitle: project.subtitle,
    description: project.description,
    coverImageId: project.coverImageId,
    details: detailList(fields, project.details),
    categories: project.categoryIds.flatMap((id) => categoryNames.get(id) ?? []),
    itemCount: project.itemCount,
    readyItemCount: project.readyItemCount,
  };
}

/** Compact, for pages of projects: an excerpt instead of the description, details as key → value. */
function projectListEntry(project: GalleryProjectWithItems, categoryNames: Map<string, string>) {
  return {
    id: project.id,
    slug: project.slug,
    title: project.title,
    subtitle: project.subtitle,
    excerpt: projectExcerpt(project.description),
    details: project.details,
    categories: project.categoryIds.flatMap((id) => categoryNames.get(id) ?? []),
    itemCount: project.itemCount,
    readyItemCount: project.readyItemCount,
    photosWithoutAltText: project.items.filter((item) => item.kind === "photo" && !item.altText).length,
  };
}

function categoryNamesOf(detail: GalleryDetail, extra: Iterable<{ id: string; name: string }> = []): Map<string, string> {
  return new Map([...detail.categories, ...extra].map((category) => [category.id, category.name] as const));
}

export interface ListProjectsOptions {
  project?: string;
  offset?: number;
  limit?: number;
}

/** Without `project`, a page of projects; with it, that project and a page of its items in order. */
export function listProjectsResult(list: GalleryProjectListResponse, detail: GalleryDetail, localPaths: Map<string, string>, options: ListProjectsOptions) {
  const categoryNames = categoryNamesOf(detail);
  const offset = options.offset ?? 0;
  const base = { showcaseId: list.showcaseId, title: detail.title, type: list.type, detailFields: list.detailFields.map(fieldView), detailsVersion: list.detailsVersion };
  if (options.project) {
    const project = findProject(list.projects, options.project);
    const limit = options.limit ?? LIST_ITEMS_DEFAULT_LIMIT;
    const page = project.items.slice(offset, offset + limit);
    return {
      ...base,
      project: projectView(project, list.detailFields, categoryNames),
      items: {
        total: project.items.length,
        offset,
        nextOffset: offset + page.length < project.items.length ? offset + page.length : null,
        items: page.map((item) => itemView(item, categoryNames, localPaths.get(item.id))),
      },
    };
  }
  const limit = options.limit ?? LIST_PROJECTS_DEFAULT_LIMIT;
  const page = list.projects.slice(offset, offset + limit);
  return {
    ...base,
    total: list.projects.length,
    offset,
    nextOffset: offset + page.length < list.projects.length ? offset + page.length : null,
    projects: page.map((project) => projectListEntry(project, categoryNames)),
    nextStep: "Pass project (slug, title, or id) to see one project's description, labeled details, and items.",
  };
}

/* Writes */

/** Validated against the showcase's details; null (or empty) clears a value. */
export function normalizeDetailValues(
  fields: readonly ProjectDetailField[],
  input: Readonly<Record<string, unknown>>,
): Record<string, ProjectDetailValue | null> {
  const fieldsByKey = new Map(fields.map((field) => [field.key, field]));
  const values: Record<string, ProjectDetailValue | null> = {};
  const problems: string[] = [];
  for (const [key, raw] of Object.entries(input)) {
    const field = fieldsByKey.get(key);
    if (!field) {
      problems.push(`This showcase has no detail "${key}".`);
      continue;
    }
    const result = normalizeProjectDetailValue(field, raw);
    if (result.ok) values[key] = result.value;
    else problems.push(result.error);
  }
  if (problems.length > 0) {
    const available =
      fields.length > 0
        ? `Its details (key: type): ${fields.map((field) => `${field.key}: ${PROJECT_DETAIL_TYPE_LABELS[field.type].toLowerCase()}${field.options ? ` (${field.options.map((option) => option.value).join(", ")})` : ""}`).join("; ")}.`
        : "It has no project details yet; add them with plan_project_details and apply_project_details first.";
    throw new UserFacingError(`${problems.join(" ")} ${available}`);
  }
  return values;
}

/** Category ids for names, slugs, or ids, in the order given; missing names are created. */
async function resolveCategoryIds(client: DroplApiClient, detail: GalleryDetail, references: readonly string[]) {
  const ids: string[] = [];
  const namesToCreate: string[] = [];
  for (const reference of references) {
    const existing = matchCategory(detail.categories, reference);
    if (existing) ids.push(existing.id);
    else {
      const name = normalizeCategoryName(reference);
      if (name) namesToCreate.push(name);
    }
  }
  const resolved = namesToCreate.length > 0 ? await ensureCategories(client, detail.id, namesToCreate, detail.categories) : new Map<string, CategoryRef>();
  for (const name of namesToCreate) {
    const category = resolved.get(categoryKey(name));
    if (!category) throw new Error(`Category "${name}" wasn't created.`);
    ids.push(category.id);
  }
  return { ids: [...new Set(ids)], createdCategories: [...resolved.values()].filter((category) => category.created) };
}

export interface CreateProjectInput {
  title: string;
  subtitle?: string | null;
  description?: string | null;
  slug?: string;
  details?: Record<string, unknown>;
  categories?: string[];
}

export async function createProject(client: DroplApiClient, showcaseId: string, input: CreateProjectInput) {
  const detail = await client.get<GalleryDetail>(showcasePath(showcaseId));
  requireProjectsShowcase(detail);
  const projects = projectsOf(detail);
  const title = collapseWhitespace(input.title);
  const existing = projects.find(
    (project) => (input.slug !== undefined && project.slug === input.slug) || collapseWhitespace(project.title).toLowerCase() === title.toLowerCase(),
  );
  if (existing) {
    return {
      project: projectView(existing, detail.projectDetailFields ?? [], categoryNamesOf(detail)),
      existed: true,
      nextStep: "A project with this title or slug already exists, so nothing was created. Use update_project to change it.",
    };
  }
  const fields = detail.projectDetailFields ?? [];
  const body: CreateGalleryProjectRequest = { title };
  if (input.subtitle !== undefined) body.subtitle = input.subtitle;
  if (input.description !== undefined) body.description = input.description;
  if (input.slug !== undefined) body.slug = input.slug;
  if (input.details) body.details = normalizeDetailValues(fields, input.details);
  let createdCategories: { id: string; name: string }[] = [];
  if (input.categories) {
    const resolved = await resolveCategoryIds(client, detail, input.categories);
    body.categoryIds = resolved.ids;
    createdCategories = resolved.createdCategories;
  }
  const response = await client.request<GalleryProjectSummary>("POST", `${showcasePath(showcaseId)}/projects`, {
    body,
    idempotencyKey: deriveIdempotencyKey("projects.create", showcaseId, body),
  });
  const project = response.data;
  return {
    project: projectView(project, fields, categoryNamesOf(detail, createdCategories)),
    existed: false,
    alreadyCreated: response.replayed,
    createdCategories: createdCategories.map((category) => category.name),
    nextStep: `Upload its photos with upload_photos { showcaseId: "${showcaseId}", project: "${project.slug}", paths } (dryRun: true first); it shows on the website once it has a ready photo or video.`,
  };
}

export interface UpdateProjectInput {
  title?: string;
  subtitle?: string | null;
  description?: string | null;
  slug?: string;
  details?: Record<string, unknown>;
  categories?: string[];
  cover?: string | null;
}

export async function updateProject(client: DroplApiClient, showcaseId: string, reference: string, input: UpdateProjectInput) {
  const detail = await client.get<GalleryDetail>(showcasePath(showcaseId));
  requireProjectsShowcase(detail);
  const project = findProject(projectsOf(detail), reference);
  const fields = detail.projectDetailFields ?? [];
  const body: UpdateGalleryProjectRequest = {};
  if (input.title !== undefined) body.title = collapseWhitespace(input.title);
  if (input.subtitle !== undefined) body.subtitle = input.subtitle;
  if (input.description !== undefined) body.description = input.description;
  if (input.slug !== undefined) body.slug = input.slug;
  if (input.details) body.details = normalizeDetailValues(fields, input.details);
  if (input.cover !== undefined) {
    if (input.cover === null) body.coverImageId = null;
    else {
      const cover = detail.images.find((item) => item.id === input.cover);
      if (!cover || cover.projectId !== project.id || cover.kind !== "photo") {
        throw new UserFacingError(`The cover must be a photo in "${project.title}"; ${input.cover} isn't one. Find its photo ids with list_projects { project: "${project.slug}" }.`);
      }
      body.coverImageId = cover.id;
    }
  }
  let createdCategories: { id: string; name: string }[] = [];
  if (input.categories) {
    const resolved = await resolveCategoryIds(client, detail, input.categories);
    body.categoryIds = resolved.ids;
    createdCategories = resolved.createdCategories;
  }
  if (Object.keys(body).length === 0) throw new UserFacingError("Nothing to change: pass at least one of title, subtitle, description, slug, details, categories, or cover.");
  const updated = await client.patch<GalleryProjectSummary>(`${showcasePath(showcaseId)}/projects/${pathSegment(project.id)}`, body);
  return {
    project: projectView(updated, fields, categoryNamesOf(detail, createdCategories)),
    createdCategories: createdCategories.map((category) => category.name),
  };
}

/** The requested ids first, in that order, then every other one in its current order. */
export function completeOrder(currentIds: readonly string[], requestedIds: readonly string[], noun: string): string[] {
  const seen = new Set<string>();
  for (const id of requestedIds) {
    if (seen.has(id)) throw new UserFacingError(`The same ${noun} is listed twice: ${id}.`);
    seen.add(id);
  }
  return [...requestedIds, ...currentIds.filter((id) => !seen.has(id))];
}

export async function reorderProjects(client: DroplApiClient, showcaseId: string, references: readonly string[]) {
  const detail = await client.get<GalleryDetail>(showcasePath(showcaseId));
  requireProjectsShowcase(detail);
  const projects = projectsOf(detail);
  const requestedIds = references.map((reference) => findProject(projects, reference).id);
  const body: ReorderGalleryProjectsRequest = { projectIds: completeOrder(projects.map((project) => project.id), requestedIds, "project") };
  const response = await client.request<GalleryProjectListResponse>("PUT", `${showcasePath(showcaseId)}/projects/order`, { body });
  return {
    showcaseId,
    order: response.data.projects.map((project, index) => ({ position: index + 1, slug: project.slug, title: project.title })),
  };
}

export async function reorderProjectItems(client: DroplApiClient, showcaseId: string, reference: string, ids: readonly string[]) {
  const list = await client.get<GalleryProjectListResponse>(`${showcasePath(showcaseId)}/projects`);
  if (list.type !== "projects") throw new UserFacingError("This is a gallery showcase without projects; reorder its items in the Dropl dashboard.");
  const project = findProject(list.projects, reference);
  const itemIds = new Set(project.items.map((item) => item.id));
  const itemIdByVideoId = new Map(project.items.flatMap((item) => (item.video ? [[item.video.id, item.id] as const] : [])));
  const unknown: string[] = [];
  const requestedIds = ids.map((id) => {
    const itemId = itemIds.has(id) ? id : itemIdByVideoId.get(id);
    if (!itemId) unknown.push(id);
    return itemId ?? id;
  });
  if (unknown.length > 0) {
    const listed = truncateList(unknown, MAX_UNKNOWN_IDS_IN_MESSAGE);
    throw new UserFacingError(
      `Not in project "${project.title}": ${listed.items.join(", ")}${listed.omitted > 0 ? ` and ${listed.omitted} more` : ""}. Use item ids from list_projects { project: "${project.slug}" }.`,
    );
  }
  const body: ReorderGalleryProjectItemsRequest = { imageIds: completeOrder(project.items.map((item) => item.id), requestedIds, "item") };
  const response = await client.request<GalleryProjectWithItems>("PUT", `${showcasePath(showcaseId)}/projects/${pathSegment(project.id)}/items/order`, { body });
  const listed = truncateList(
    response.data.items.map((item, index) => ({ position: index + 1, id: item.id, fileName: item.video?.title ?? item.sourceFileName })),
    MAX_LISTED_REORDERED_ITEMS,
  );
  return { showcaseId, project: projectTarget(response.data), items: listed.items, itemsOmitted: listed.omitted };
}

/* Details schema */

export const projectDetailsPath = (showcaseId: string) => `${showcasePath(showcaseId)}/project-details`;

export function projectDetailsResult(showcaseId: string, schema: ProjectDetailsSchemaResponse) {
  return {
    showcaseId,
    version: schema.version,
    fields: schema.fields.map(fieldView),
    rules: PROJECT_DETAIL_EDIT_RULES.keepKeys,
  };
}

export interface ProjectDetailsChangeOptions {
  fields: ProjectDetailFieldInput[];
  expectedVersion: number;
  dryRun: boolean;
  confirmDestructive?: boolean;
}

export async function changeProjectDetails(client: DroplApiClient, showcaseId: string, options: ProjectDetailsChangeOptions) {
  const cardCount = options.fields.filter((field) => field.showOnCard).length;
  if (cardCount > MAX_PROJECT_CARD_DETAILS) throw new UserFacingError(`Show at most ${MAX_PROJECT_CARD_DETAILS} details on project cards; ${cardCount} have showOnCard: true.`);
  const body: UpdateProjectDetailFieldsRequest = {
    fields: options.fields,
    expectedVersion: options.expectedVersion,
    dryRun: options.dryRun,
    ...(!options.dryRun && { confirmDestructive: options.confirmDestructive === true }),
  };
  const response = await client.request<UpdateProjectDetailFieldsResponse>("PUT", projectDetailsPath(showcaseId), {
    body,
    ...(!options.dryRun && { idempotencyKey: deriveIdempotencyKey("projects.details", showcaseId, body) }),
  });
  return projectDetailsChangeResult(response.data, options.dryRun, options.expectedVersion);
}

export function projectDetailsChangeResult(response: UpdateProjectDetailFieldsResponse, dryRun: boolean, expectedVersion: number) {
  const destructive = isDestructiveProjectDetailChange(response.changes);
  let nextStep: string;
  if (!dryRun) nextStep = "Saved. Fill in each project's values with update_project (details by key).";
  else if (response.changes.length === 0) nextStep = "Nothing would change.";
  else if (destructive) {
    nextStep = `Show the summary to the user; lines marked ! remove values projects have. Call apply_project_details with the same fields and expectedVersion ${expectedVersion}, and confirmDestructive: true only after they explicitly agree to every destructive change.`;
  } else nextStep = `Show the summary to the user, then call apply_project_details with the same fields and expectedVersion ${expectedVersion} once they confirm.`;
  return {
    applied: response.applied,
    destructive,
    summary: response.summary || describeProjectDetailChanges(response.changes),
    changes: response.changes,
    fields: response.fields.map(fieldView),
    version: response.version,
    nextStep,
  };
}
