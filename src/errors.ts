import { PUBLIC_API_ERROR_CODES } from "@dropl/shared";
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
};

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
    const hint = HINTS_BY_CODE[error.code];
    if (hint) parts.push(hint);
    return parts.join(" ");
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}
