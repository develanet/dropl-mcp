import { homedir } from "node:os";
import path from "node:path";

export const DEFAULT_API_URL = "https://www.dropl.io/api";
export const API_URL_ENV = "DROPL_API_URL";
export const API_KEY_ENV = "DROPL_API_KEY";
export const LOGIN_COMMAND = "npx -y @dropl/mcp login";
const CONFIG_DIRECTORY_NAME = "dropl";
/** WHATWG `URL.hostname` keeps the brackets around IPv6 literals. */
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTNAMES.has(hostname.toLowerCase());
}

/** Plain http is only acceptable on this machine; anywhere else it would expose keys and upload URLs. */
export function assertSecureUrl(url: URL, description: string): void {
  if (url.protocol === "https:") return;
  if (url.protocol === "http:" && isLoopbackHostname(url.hostname)) return;
  if (url.protocol === "http:") {
    throw new ConfigError(`${description} must use https (plain http is only allowed for localhost): ${url.origin}`);
  }
  throw new ConfigError(`${description} must be an http(s) URL, got ${url.protocol}`);
}

/** Returns the URL without a trailing slash, the form used as the credentials profile key. */
export function normalizeApiUrl(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    throw new ConfigError(`Invalid Dropl API URL: ${rawUrl}`);
  }
  assertSecureUrl(url, "The Dropl API URL");
  if (url.username || url.password) throw new ConfigError("The Dropl API URL must not contain a username or password.");
  if (url.search || url.hash) throw new ConfigError("The Dropl API URL must not contain a query string or fragment.");
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

export function resolveApiUrl(env: NodeJS.ProcessEnv, override?: string): string {
  return normalizeApiUrl(override ?? (env[API_URL_ENV]?.trim() || DEFAULT_API_URL));
}

export interface PlatformContext {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  homeDirectory: string;
}

export function currentPlatformContext(): PlatformContext {
  return { env: process.env, platform: process.platform, homeDirectory: homedir() };
}

/** `%APPDATA%\dropl` on Windows, else `$XDG_CONFIG_HOME/dropl` or `~/.config/dropl`. */
export function configDirectory(context: PlatformContext): string {
  if (context.platform === "win32") {
    const appData = context.env.APPDATA?.trim() || path.join(context.homeDirectory, "AppData", "Roaming");
    return path.join(appData, CONFIG_DIRECTORY_NAME);
  }
  const xdgConfigHome = context.env.XDG_CONFIG_HOME?.trim();
  // The XDG spec says relative values are invalid and must be ignored.
  const base = xdgConfigHome && path.isAbsolute(xdgConfigHome) ? xdgConfigHome : path.join(context.homeDirectory, ".config");
  return path.join(base, CONFIG_DIRECTORY_NAME);
}
