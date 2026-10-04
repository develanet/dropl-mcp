import {
  collapseWhitespace,
  slugifyCategoryName,
  slugifyProjectTitle,
  type PublicApiShowcaseEmbedResponse,
  type PublicApiVideoEmbedResponse,
} from "@dropl/shared";
import { UserFacingError } from "./errors.js";
import { truncateList } from "./format.js";

const SCRIPT_SRC_PATTERN = /<script\b[^>]*\bsrc="([^"]+)"/i;
const CONTAINER_PATTERN = /^\s*(<div\b[^>]*><\/div>)/i;
const MAX_LISTED_PROJECT_SNIPPETS = 20;

/** Short, accurate placement advice; the loader also mounts containers added later (client-side navigation). */
export const EMBED_PLACEMENT_GUIDE: readonly string[] = [
  "Plain HTML: paste the snippet where the media should appear. With several embeds on one page, the <script> tag is only needed once.",
  "React / Next.js: browsers don't run <script> tags inserted with dangerouslySetInnerHTML, and JSX won't run them either. Render the <div> container as JSX (keep its data-* attributes) and load the script once: in Next.js with next/script (<Script src=\"…\" strategy=\"afterInteractive\" />, e.g. in the layout); in other React apps by appending a <script async> element in a useEffect.",
  "WordPress: add a Custom HTML block and paste the snippet.",
  "Webflow: add an Embed (Code Embed) element; Framer: an Embed component set to HTML; Squarespace: a Code block. Paste the snippet.",
];

function scriptSource(html: string): string | null {
  return SCRIPT_SRC_PATTERN.exec(html)?.[1] ?? null;
}

function containerElement(html: string): string | null {
  return CONTAINER_PATTERN.exec(html)?.[1] ?? null;
}

export interface EmbedCodeResult {
  kind: "video" | "showcase";
  id: string;
  publicId: string;
  html: string;
  /** For frameworks: the container to render and the script to load once. */
  container: string | null;
  scriptSrc: string | null;
  category: { id: string; name: string; slug: string } | null;
  otherCategorySnippets: { name: string; slug: string }[];
  /** Projects showcases only. */
  type?: "projects";
  project?: { id: string; title: string; slug: string } | null;
  projectUrl?: string | null;
  /** Other projects with a page snippet (get_embed_code with project). */
  projectSnippets?: { title: string; slug: string }[];
  embeddable?: boolean;
  watchUrl?: string | null;
  notes: string[];
  whereToPaste: readonly string[];
}

export function videoEmbedResult(response: PublicApiVideoEmbedResponse): EmbedCodeResult {
  return {
    kind: "video",
    id: response.videoId,
    publicId: response.publicId,
    html: response.html,
    container: containerElement(response.html),
    scriptSrc: scriptSource(response.html),
    category: null,
    otherCategorySnippets: [],
    embeddable: response.embeddable,
    watchUrl: response.watchUrl,
    notes: response.notes,
    whereToPaste: EMBED_PLACEMENT_GUIDE,
  };
}

export interface ShowcaseEmbedOptions {
  /** Name or slug: that category's snippet, which shows only its items without filter tabs. */
  category?: string;
  /** Projects showcases: slug, title, or id of the project whose page snippet to return. */
  project?: string;
  /** The `projectUrl` template the response was requested with, e.g. `/work/{slug}`. */
  projectUrl?: string;
}

type ProjectSnippet = NonNullable<PublicApiShowcaseEmbedResponse["projects"]>[number];

function findProjectSnippet(snippets: readonly ProjectSnippet[], reference: string): ProjectSnippet {
  const wanted = collapseWhitespace(reference);
  const match =
    snippets.find((entry) => entry.id === wanted || entry.slug === wanted) ??
    snippets.find((entry) => collapseWhitespace(entry.title).toLowerCase() === wanted.toLowerCase()) ??
    snippets.find((entry) => entry.slug === slugifyProjectTitle(wanted));
  if (match) return match;
  const available = truncateList(snippets, MAX_LISTED_PROJECT_SNIPPETS);
  const listed = available.items.map((entry) => `${entry.title} (${entry.slug})`).join(", ") || "none";
  throw new UserFacingError(`This showcase has no project "${reference}". Projects: ${listed}${available.omitted > 0 ? `, and ${available.omitted} more` : ""}.`);
}

function projectNotes(projectUrl: string | undefined, selected: ProjectSnippet | null): string[] {
  const notes = [
    "This is a projects showcase: the main snippet shows the projects index and opens each project's page in place.",
  ];
  if (selected) notes.push(`This snippet shows only the "${selected.title}" project page; put it on that project's own page of the website.`);
  if (projectUrl) {
    notes.push(
      `With projectUrl, index cards link to ${projectUrl} on the website instead of opening in place, so each project needs that page: embed its project snippet there (get_embed_code with project). For a dynamic route such as /work/[slug], render the project snippet's container with its data-project attribute set to the page's slug.`,
    );
  } else {
    notes.push('To give each project its own page on the website (better for search), call get_embed_code again with projectUrl, e.g. "/work/{slug}", and add those pages.');
  }
  return notes;
}

export function showcaseEmbedResult(response: PublicApiShowcaseEmbedResponse, options: ShowcaseEmbedOptions = {}): EmbedCodeResult {
  const { category, project, projectUrl } = options;
  const isProjects = response.type === "projects";
  if (!isProjects && (project || projectUrl)) {
    throw new UserFacingError("project and projectUrl only apply to projects showcases; this one is a gallery.");
  }
  if (category?.trim() && project?.trim()) throw new UserFacingError("Pass either category or project, not both.");
  const projectSnippets = response.projects ?? [];
  const selectedProject = project?.trim() ? findProjectSnippet(projectSnippets, project) : null;

  let selected: PublicApiShowcaseEmbedResponse["categories"][number] | null = null;
  if (category?.trim()) {
    const wanted = category.trim().toLowerCase();
    const wantedSlug = slugifyCategoryName(category);
    selected = response.categories.find((entry) => entry.slug === wanted || entry.slug === wantedSlug || entry.name.toLowerCase() === wanted) ?? null;
    if (!selected) {
      const available = response.categories.map((entry) => `${entry.name} (${entry.slug})`).join(", ") || "none";
      throw new UserFacingError(`This showcase has no category "${category}". Categories: ${available}.`);
    }
  }
  const html = selectedProject?.html ?? selected?.html ?? response.html;
  return {
    kind: "showcase",
    id: response.showcaseId,
    publicId: response.publicId,
    html,
    container: containerElement(html),
    scriptSrc: scriptSource(html),
    category: selected ? { id: selected.id, name: selected.name, slug: selected.slug } : null,
    otherCategorySnippets: response.categories.filter((entry) => entry.id !== selected?.id).map((entry) => ({ name: entry.name, slug: entry.slug })),
    ...(isProjects && {
      type: "projects" as const,
      project: selectedProject ? { id: selectedProject.id, title: selectedProject.title, slug: selectedProject.slug } : null,
      projectUrl: projectUrl ?? null,
      projectSnippets: projectSnippets.filter((entry) => entry.id !== selectedProject?.id).map((entry) => ({ title: entry.title, slug: entry.slug })),
    }),
    notes: isProjects ? [...response.notes, ...projectNotes(projectUrl, selectedProject)] : response.notes,
    whereToPaste: EMBED_PLACEMENT_GUIDE,
  };
}
