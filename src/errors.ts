import { FEEDBACK_PLAN_REQUIRED_CODE, PROJECT_ERROR_CODES, PUBLIC_API_ERROR_CODES, SHOWCASE_PRIVATE_CODE } from "@dropl/shared";
import { LOGIN_COMMAND, API_KEY_ENV } from "./config.js";

export const NETWORK_ERROR_CODE = "NETWORK_ERROR";
const MAX_FIELD_ERRORS_SHOWN = 5;

/** An error response from the Dropl API, or status 0 when the request never got one. */
export class DroplApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fieldErrors: Record<string, string[]> | null = null,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = "DroplApiError";
  }
}

/** A problem the agent or user can fix (bad input, missing credentials); shown as is. */
export class UserFacingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserFacingError";
  }
}

const HINTS_BY_CODE: Record<string, string> = {
  [PUBLIC_API_ERROR_CODES.invalidApiKey]: `The API key was rejected (revoked, expired, or its creator is no longer an owner or admin). Ask the user to run \`${LOGIN_COMMAND}\` in a terminal, or to update ${API_KEY_ENV}. Never ask them to paste a key into the chat.`,
  [PUBLIC_API_ERROR_CODES.insufficientScope]: "Ask the user to sign in again or create a key with the scope named above (Dropl → Settings → API keys).",
  [PUBLIC_API_ERROR_CODES.siteRestrictedKey]: "This key is limited to specific client sites. Ask the user to pick one of the sites from list_sites, or to use a key with access to every site.",
  SUBSCRIPTION_REQUIRED: "The account needs an active plan. Ask the user to check Billing in the Dropl dashboard.",
  GALLERY_FULL: "Create another showcase for the remaining items.",
  [PROJECT_ERROR_CODES.schemaChanged]:
    "Someone changed these fields since you read them. Read them again (get_collection_schema for a collection, get_project_details for project details), rebuild the change from the current fields, and show the new diff to the user. Never undo their edits.",
  [PROJECT_ERROR_CODES.confirmationRequired]:
    "This change loses data (values items or projects have) or renames something websites rely on. Show the diff to the user and only retry with confirmDestructive: true after they explicitly agree.",
  [PROJECT_ERROR_CODES.projectRequired]:
    "This is a projects showcase: every photo and video belongs to a project. Pass project (slug, title, or id from list_projects), or create the project first with create_project.",
  [PROJECT_ERROR_CODES.notProjectsShowcase]: "This is a gallery showcase; leave out project. Projects need a showcase created with type: \"projects\".",
  [PROJECT_ERROR_CODES.projectNotFound]: "That project isn't in this showcase (it may have been deleted in the dashboard). Run list_projects for the current projects.",
  [PROJECT_ERROR_CODES.tooManyProjects]: "This showcase holds the maximum number of projects. Tell the user; split the portfolio across several projects showcases only if they agree.",
  [PROJECT_ERROR_CODES.projectSlugTaken]:
    "Another project in this showcase uses that slug. Pick a different slug, or update the existing project (list_projects) instead of creating a duplicate.",
  [PROJECT_ERROR_CODES.showcaseNotEmpty]:
    "A showcase's type can only change while it has no items and no projects. Create a new showcase with the type you need instead.",
  [PROJECT_ERROR_CODES.invalidDetails]:
    "Check the details against get_project_details: values use each detail's key and type (numbers as numbers, select as an option value, dates as YYYY-MM-DD, links as https URLs); definitions keep existing keys and option values exactly.",
  ITEM_LIMIT_REACHED: "The account is out of collection items on its plan. Tell the user; they can upgrade or buy an item add-on under Billing.",
  COLLECTION_FULL: "This collection holds its maximum number of items. Tell the user; don't split it on your own.",
  COLLECTION_LIMIT_REACHED: "The site has as many collections as its plan allows. Tell the user, or reuse an existing collection.",
  UNDO_NOT_AVAILABLE: "Only the most recent schema change can be undone, and only while no data written since then would be lost. Tell the user what changed instead.",
  [FEEDBACK_PLAN_REQUIRED_CODE]: "The account's plan doesn't include this. Tell the user; they can upgrade under Billing in the Dropl dashboard. Don't retry.",
  [SHOWCASE_PRIVATE_CODE]: "This showcase holds private client photos and is never public. Don't embed it or write embed HTML for it; to use a photo on the website, ask the user to add it to another showcase.",
  FEEDBACK_CHANGED: "Someone changed this request's status since you read it. Run get_feedback again and check with the user before changing it.",
};

/** Keys made before Feedback existed lack its scopes; signing in again issues a key with every scope. */
const FEEDBACK_SCOPE_HINT = `This key was created before Feedback was available. Ask the user to run \`${LOGIN_COMMAND}\` in a terminal to sign in again (the new key includes the feedback scopes), then retry. Never ask them to paste a key into the chat.`;

function hintFor(error: DroplApiError): string | undefined {
  if (error.code === PUBLIC_API_ERROR_CODES.insufficientScope && error.message.includes("feedback:")) return FEEDBACK_SCOPE_HINT;
  return HINTS_BY_CODE[error.code];
}

/** One line for the agent: the API's message verbatim, its code, and what to do about it. */
export function describeError(error: unknown): string {
  if (error instanceof DroplApiError) {
    const parts = [`${error.message} (${error.code}${error.status ? `, HTTP ${error.status}` : ""})`];
    if (error.fieldErrors) {
      const fieldMessages = Object.entries(error.fieldErrors)
        .slice(0, MAX_FIELD_ERRORS_SHOWN)
        .map(([field, messages]) => `${field}: ${messages.join(", ")}`);
      if (fieldMessages.length > 0) parts.push(`Fields: ${fieldMessages.join("; ")}`);
    }
    const hint = hintFor(error);
    if (hint) parts.push(hint);
    return parts.join(" ");
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}
