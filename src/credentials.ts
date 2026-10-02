import { readFile, lstat } from "node:fs/promises";
import path from "node:path";
import { API_KEY_DISPLAY_PREFIX_LENGTH, API_KEY_PATTERN } from "@dropl/shared";
import { API_KEY_ENV, LOGIN_COMMAND } from "./config.js";
import { GROUP_OR_WORLD_ACCESS_MASK, isNodeError, writeFileAtomic } from "./fs-utils.js";

const CREDENTIALS_FILE_NAME = "credentials.json";
const CREDENTIALS_FILE_VERSION = 1;

export interface StoredProfile {
  apiKey: string;
  organization: { id: string; name: string };
  keyName: string;
  createdAt: string;
}

export interface CredentialsFile {
  version: typeof CREDENTIALS_FILE_VERSION;
  /** Keyed by the normalized API URL, so local dev and production sign-ins don't collide. */
  profiles: Record<string, StoredProfile>;
}

export type CredentialsErrorReason = "missing" | "insecure_file" | "malformed_file" | "invalid_key";

export class CredentialsError extends Error {
  constructor(
    readonly reason: CredentialsErrorReason,
    message: string,
  ) {
    super(message);
    this.name = "CredentialsError";
  }
}

export interface ResolvedCredentials {
  source: "env" | "file";
  apiKey: string;
  apiUrl: string;
  /** Set when the key came from the credentials file. */
  profile: StoredProfile | null;
}

export function credentialsPath(configDirectory: string): string {
  return path.join(configDirectory, CREDENTIALS_FILE_NAME);
}

/** e.g. `dropl_live_ab12…`; the rest of the key is never printed. */
export function displayKeyPrefix(apiKey: string): string {
  return `${apiKey.slice(0, API_KEY_DISPLAY_PREFIX_LENGTH)}…`;
}

function isStoredProfile(value: unknown): value is StoredProfile {
  if (typeof value !== "object" || value === null) return false;
  const profile = value as Record<string, unknown>;
  const organization = profile.organization as Record<string, unknown> | null | undefined;
  return (
    typeof profile.apiKey === "string" &&
    typeof profile.keyName === "string" &&
    typeof profile.createdAt === "string" &&
    typeof organization === "object" &&
    organization !== null &&
    typeof organization.id === "string" &&
    typeof organization.name === "string"
  );
}

function emptyCredentials(): CredentialsFile {
  return { version: CREDENTIALS_FILE_VERSION, profiles: {} };
}

/** Null when there's no file. Refuses (throws) a file other users could read. */
export async function readCredentialsFile(
  filePath: string,
  platform: NodeJS.Platform = process.platform,
): Promise<CredentialsFile | null> {
  let stats;
  try {
    stats = await lstat(filePath);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return null;
    throw error;
  }
  if (!stats.isFile()) {
    throw new CredentialsError("insecure_file", `${filePath} is not a regular file; refusing to read credentials from it.`);
  }
  if (platform !== "win32" && (stats.mode & GROUP_OR_WORLD_ACCESS_MASK) !== 0) {
    throw new CredentialsError(
      "insecure_file",
      `${filePath} can be read by other users, so it was ignored. Run \`chmod 600 ${filePath}\` to make it private, then try again.`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    throw new CredentialsError("malformed_file", `${filePath} isn't valid JSON. Delete it and run \`${LOGIN_COMMAND}\` again.`);
  }
  const candidate = parsed as Partial<CredentialsFile> | null;
  if (candidate?.version !== CREDENTIALS_FILE_VERSION || typeof candidate.profiles !== "object" || candidate.profiles === null) {
    throw new CredentialsError("malformed_file", `${filePath} has an unknown format. Delete it and run \`${LOGIN_COMMAND}\` again.`);
  }
  const profiles: Record<string, StoredProfile> = {};
  for (const [apiUrl, profile] of Object.entries(candidate.profiles)) {
    if (isStoredProfile(profile)) profiles[apiUrl] = profile;
  }
  return { version: CREDENTIALS_FILE_VERSION, profiles };
}

export async function saveProfile(filePath: string, apiUrl: string, profile: StoredProfile): Promise<void> {
  if (!API_KEY_PATTERN.test(profile.apiKey)) throw new CredentialsError("invalid_key", "Refusing to save a malformed API key.");
  const existing = await readCredentialsFile(filePath).catch((error: unknown) => {
    // A broken or over-shared file is replaced by a fresh private one rather than blocking sign-in.
    if (error instanceof CredentialsError) return null;
    throw error;
  });
  const credentials = existing ?? emptyCredentials();
  credentials.profiles[apiUrl] = profile;
  await writeFileAtomic(filePath, `${JSON.stringify(credentials, null, 2)}\n`);
}

/** Returns the removed profile, or null when there wasn't one. */
export async function removeProfile(filePath: string, apiUrl: string): Promise<StoredProfile | null> {
  const credentials = await readCredentialsFile(filePath);
  const profile = credentials?.profiles[apiUrl];
  if (!credentials || !profile) return null;
  delete credentials.profiles[apiUrl];
  await writeFileAtomic(filePath, `${JSON.stringify(credentials, null, 2)}\n`);
  return profile;
}

export interface ResolveCredentialsOptions {
  env: NodeJS.ProcessEnv;
  apiUrl: string;
  credentialsFilePath: string;
  platform?: NodeJS.Platform;
}

/** `DROPL_API_KEY` wins over the stored profile for this API URL. */
export async function resolveCredentials(options: ResolveCredentialsOptions): Promise<ResolvedCredentials> {
  const environmentKey = options.env[API_KEY_ENV]?.trim();
  if (environmentKey) {
    if (!API_KEY_PATTERN.test(environmentKey)) {
      throw new CredentialsError(
        "invalid_key",
        `${API_KEY_ENV} doesn't look like a Dropl API key (dropl_live_… or dropl_test_…). Ask the user to copy it again from Dropl → Settings → API keys, or unset it and run \`${LOGIN_COMMAND}\`.`,
      );
    }
    return { source: "env", apiKey: environmentKey, apiUrl: options.apiUrl, profile: null };
  }

  const credentials = await readCredentialsFile(options.credentialsFilePath, options.platform);
  const profile = credentials?.profiles[options.apiUrl];
  if (!profile) {
    throw new CredentialsError(
      "missing",
      `Not signed in to Dropl (${options.apiUrl}). Ask the user to run \`${LOGIN_COMMAND}\` in a terminal and approve the sign-in in their browser, or to set ${API_KEY_ENV} in this MCP server's config. Never ask them to paste an API key into the chat.`,
    );
  }
  if (!API_KEY_PATTERN.test(profile.apiKey)) {
    throw new CredentialsError("invalid_key", `The stored Dropl key for ${options.apiUrl} is malformed. Ask the user to run \`${LOGIN_COMMAND}\` again.`);
  }
  return { source: "file", apiKey: profile.apiKey, apiUrl: options.apiUrl, profile };
}
