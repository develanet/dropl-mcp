import { hostname as osHostname } from "node:os";
import { parseArgs } from "node:util";
import type { PublicApiMeResponse } from "@dropl/shared";
import { DroplApiClient } from "./api-client.js";
import { openBrowser as defaultOpenBrowser } from "./browser.js";
import { API_KEY_ENV, configDirectory, environmentApiKey, resolveApiUrl, type PlatformContext } from "./config.js";
import { credentialsPath, displayKeyPrefix, removeProfile, resolveCredentials, saveProfile } from "./credentials.js";
import { DEFAULT_CLIENT_NAME, runDeviceLogin } from "./device-login.js";
import { describeError } from "./errors.js";
import { sleep as defaultSleep, type Sleep } from "./retry.js";
import { PACKAGE_VERSION } from "./version.js";

export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;

export const HELP_TEXT = `dropl-mcp ${PACKAGE_VERSION}: Dropl MCP server for AI coding agents

Usage:
  dropl-mcp                      Run the MCP server over stdio (what your MCP client starts)
  dropl-mcp login [options]      Sign in through the browser and save an API key for this computer
  dropl-mcp logout [--api-url]   Remove the saved key for this computer
  dropl-mcp whoami [--api-url]   Show the connected account and key

Options:
  --api-url <url>   Dropl API URL (default: $DROPL_API_URL or https://www.dropl.io/api)
  --client <name>   Name shown when approving the sign-in, e.g. "Cursor" (default: "${DEFAULT_CLIENT_NAME}")
  --no-browser      Print the sign-in link without opening a browser
  -h, --help        Show this help
  -v, --version     Show the version

Environment:
  ${API_KEY_ENV}     An API key from Dropl → Settings → API keys (overrides the saved sign-in)
  DROPL_API_URL     Dropl API URL
`;

export interface CliEnvironment {
  platform: PlatformContext;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  startServer: () => Promise<void>;
  fetch?: typeof fetch;
  sleep?: Sleep;
  now?: () => number;
  openBrowser?: (url: string) => boolean;
  hostname?: () => string;
}

const COMMANDS = new Set(["login", "logout", "whoami"]);

export async function runCli(argv: readonly string[], environment: CliEnvironment): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {
        "api-url": { type: "string" },
        client: { type: "string" },
        "no-browser": { type: "boolean" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
      },
    });
  } catch (error) {
    environment.stderr(`${describeError(error)}\n\n${HELP_TEXT}`);
    return EXIT_USAGE;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    environment.stdout(HELP_TEXT);
    return EXIT_OK;
  }
  if (values.version) {
    environment.stdout(PACKAGE_VERSION);
    return EXIT_OK;
  }
  const [command, ...extra] = positionals;
  if (!command) {
    await environment.startServer();
    return EXIT_OK;
  }
  if (!COMMANDS.has(command) || extra.length > 0) {
    environment.stderr(`Unknown command: ${[command, ...extra].join(" ")}\n\n${HELP_TEXT}`);
    return EXIT_USAGE;
  }

  try {
    const apiUrl = resolveApiUrl(environment.platform.env, values["api-url"]);
    const filePath = credentialsPath(configDirectory(environment.platform));
    if (command === "login") {
      return await login(environment, apiUrl, filePath, values.client, values["no-browser"] ?? false);
    }
    if (command === "logout") return await logout(environment, apiUrl, filePath);
    return await whoami(environment, apiUrl, filePath);
  } catch (error) {
    environment.stderr(`Error: ${describeError(error)}`);
    return EXIT_FAILURE;
  }
}

async function login(environment: CliEnvironment, apiUrl: string, filePath: string, clientName: string | undefined, noBrowser: boolean): Promise<number> {
  const now = environment.now ?? Date.now;
  const client = new DroplApiClient({ apiUrl, fetch: environment.fetch, sleep: environment.sleep });
  const token = await runDeviceLogin({
    client,
    clientName,
    deviceName: (environment.hostname ?? osHostname)(),
    openBrowser: noBrowser ? null : (environment.openBrowser ?? defaultOpenBrowser),
    print: environment.stdout,
    sleep: environment.sleep ?? defaultSleep,
    now,
  });
  await saveProfile(filePath, apiUrl, {
    apiKey: token.access_token,
    organization: token.organization,
    keyName: token.api_key.name,
    createdAt: new Date(now()).toISOString(),
  });
  environment.stdout("");
  environment.stdout(`Connected to ${token.organization.name} as ${token.api_key.name} (${displayKeyPrefix(token.access_token)}).`);
  environment.stdout(`Saved to ${filePath} (readable only by you).`);
  if (environmentApiKey(environment.platform.env)) {
    environment.stdout(`Note: ${API_KEY_ENV} is set and takes precedence over this sign-in.`);
  }
  return EXIT_OK;
}

async function logout(environment: CliEnvironment, apiUrl: string, filePath: string): Promise<number> {
  const removed = await removeProfile(filePath, apiUrl);
  if (!removed) {
    environment.stdout(`No saved sign-in for ${apiUrl}.`);
  } else {
    environment.stdout(`Removed the saved key ${displayKeyPrefix(removed.apiKey)} ("${removed.keyName}", ${removed.organization.name}) from this computer.`);
    environment.stdout("The key still works until it's revoked: revoke it in Dropl → Settings → API keys.");
  }
  if (environmentApiKey(environment.platform.env)) environment.stdout(`${API_KEY_ENV} is still set in this environment.`);
  return EXIT_OK;
}

async function whoami(environment: CliEnvironment, apiUrl: string, filePath: string): Promise<number> {
  const credentials = await resolveCredentials({ env: environment.platform.env, apiUrl, credentialsFilePath: filePath, platform: environment.platform.platform });
  const client = new DroplApiClient({ apiUrl, apiKey: credentials.apiKey, fetch: environment.fetch, sleep: environment.sleep });
  const me = await client.get<PublicApiMeResponse>("/v1/me");
  environment.stdout(`Account: ${me.organization.name}`);
  environment.stdout(`User:    ${me.user.name ? `${me.user.name} <${me.user.email}>` : me.user.email} (${me.role.toLowerCase()})`);
  environment.stdout(`Key:     ${me.apiKey.name} (${me.apiKey.prefix}…) from ${credentials.source === "env" ? API_KEY_ENV : "saved sign-in"}`);
  environment.stdout(`Scopes:  ${me.apiKey.scopes.join(", ")}`);
  environment.stdout(`Sites:   ${me.apiKey.siteIds ? me.apiKey.siteIds.join(", ") : "all client sites"}`);
  environment.stdout(`API:     ${apiUrl}`);
  return EXIT_OK;
}