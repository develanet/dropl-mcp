import { slugifyCategoryName, type PublicApiShowcaseEmbedResponse, type PublicApiVideoEmbedResponse } from "@dropl/shared";
import { UserFacingError } from "./errors.js";

const SCRIPT_SRC_PATTERN = /<script\b[^>]*\bsrc="([^"]+)"/i;
const CONTAINER_PATTERN = /^\s*(<div\b[^>]*><\/div>)/i;

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

/** With `category` (name or slug), returns that category's snippet, which shows only its items without filter tabs. */
export function showcaseEmbedResult(response: PublicApiShowcaseEmbedResponse, category?: string): EmbedCodeResult {
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
  const html = selected?.html ?? response.html;
  return {
    kind: "showcase",
    id: response.showcaseId,
    publicId: response.publicId,
    html,
    container: containerElement(html),
    scriptSrc: scriptSource(html),
    category: selected ? { id: selected.id, name: selected.name, slug: selected.slug } : null,
    otherCategorySnippets: response.categories.filter((entry) => entry.id !== selected?.id).map((entry) => ({ name: entry.name, slug: entry.slug })),
    notes: response.notes,
    whereToPaste: EMBED_PLACEMENT_GUIDE,
  };
}
