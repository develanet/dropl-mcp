import {
  API_KEY_PATTERN,
  DEVICE_CLIENT_NAME_MAX_LENGTH,
  DEVICE_GRANT_TYPE,
  DEVICE_NAME_MAX_LENGTH,
  DEVICE_POLL_INTERVAL_SECONDS,
  DEVICE_SLOW_DOWN_INCREMENT_SECONDS,
  type DeviceAuthorizationRequest,
  type DeviceAuthorizationResponse,
  type DeviceTokenErrorCode,
  type DeviceTokenRequest,
  type DeviceTokenResponse,
} from "@dropl/shared";
import type { DroplApiClient } from "./api-client.js";
import { assertSecureUrl } from "./config.js";
import { DroplApiError } from "./errors.js";
import type { Sleep } from "./retry.js";

export const DEFAULT_CLIENT_NAME = "Dropl MCP";
const MS_PER_SECOND = 1_000;
const HTTP_BAD_REQUEST = 400;

export type DeviceLoginFailure = "denied" | "expired" | "failed";

export class DeviceLoginError extends Error {
  constructor(
    readonly reason: DeviceLoginFailure,
    message: string,
  ) {
    super(message);
    this.name = "DeviceLoginError";
  }
}

export interface DeviceLoginOptions {
  /** A client without an API key. */
  client: DroplApiClient;
  clientName?: string;
  deviceName?: string;
  openBrowser: ((url: string) => boolean) | null;
  print: (line: string) => void;
  sleep: Sleep;
  now?: () => number;
}

function trimToLength(value: string, maxLength: number): string {
  return value.trim().slice(0, maxLength).trim();
}

function assertAuthorizationResponse(value: unknown): asserts value is DeviceAuthorizationResponse {
  const response = value as Partial<DeviceAuthorizationResponse> | null;
  const valid =
    typeof response?.device_code === "string" &&
    typeof response.user_code === "string" &&
    typeof response.verification_uri === "string" &&
    typeof response.verification_uri_complete === "string" &&
    typeof response.expires_in === "number" &&
    response.expires_in > 0;
  if (!valid) throw new DeviceLoginError("failed", "Dropl returned an unexpected sign-in response.");
  assertSecureUrl(new URL(response.verification_uri!), "The sign-in URL");
  assertSecureUrl(new URL(response.verification_uri_complete!), "The sign-in URL");
}

function assertTokenResponse(value: unknown): asserts value is DeviceTokenResponse {
  const response = value as Partial<DeviceTokenResponse> | null;
  const valid =
    typeof response?.access_token === "string" &&
    API_KEY_PATTERN.test(response.access_token) &&
    typeof response.api_key?.name === "string" &&
    typeof response.organization?.id === "string" &&
    typeof response.organization.name === "string";
  if (!valid) throw new DeviceLoginError("failed", "Dropl returned an unexpected token response.");
}

/** RFC 8628 device flow: show a code, let the user approve it in the browser, poll until they do. */
export async function runDeviceLogin(options: DeviceLoginOptions): Promise<DeviceTokenResponse> {
  const now = options.now ?? Date.now;
  const request: DeviceAuthorizationRequest = {
    client_name: trimToLength(options.clientName || DEFAULT_CLIENT_NAME, DEVICE_CLIENT_NAME_MAX_LENGTH),
  };
  const deviceName = options.deviceName ? trimToLength(options.deviceName, DEVICE_NAME_MAX_LENGTH) : "";
  if (deviceName) request.device_name = deviceName;

  const authorization = await options.client.post<unknown>("/v1/auth/device", request);
  assertAuthorizationResponse(authorization);

  options.print("");
  options.print("To connect Dropl, open this page and confirm the code:");
  options.print("");
  options.print(`  ${authorization.verification_uri}`);
  options.print(`  Code: ${authorization.user_code}`);
  options.print("");
  const launched = options.openBrowser?.(authorization.verification_uri_complete) ?? false;
  options.print(launched ? "Opened your browser. Waiting for approval…" : "Waiting for approval…");

  const deadline = now() + authorization.expires_in * MS_PER_SECOND;
  const initialIntervalSeconds = authorization.interval > 0 ? authorization.interval : DEVICE_POLL_INTERVAL_SECONDS;
  let intervalMs = initialIntervalSeconds * MS_PER_SECOND;
  const tokenRequest: DeviceTokenRequest = { grant_type: DEVICE_GRANT_TYPE, device_code: authorization.device_code };

  for (;;) {
    await options.sleep(intervalMs);
    if (now() >= deadline) throw new DeviceLoginError("expired", "The sign-in code expired. Run `dropl-mcp login` again.");
    try {
      const token = await options.client.post<unknown>("/v1/auth/device/token", tokenRequest);
      assertTokenResponse(token);
      return token;
    } catch (error) {
      if (!(error instanceof DroplApiError) || error.status !== HTTP_BAD_REQUEST) throw error;
      const code = error.code as DeviceTokenErrorCode;
      if (code === "authorization_pending") continue;
      if (code === "slow_down") {
        intervalMs += DEVICE_SLOW_DOWN_INCREMENT_SECONDS * MS_PER_SECOND;
        continue;
      }
      if (code === "access_denied") throw new DeviceLoginError("denied", "The sign-in was denied in the browser.");
      if (code === "expired_token") throw new DeviceLoginError("expired", "The sign-in code expired. Run `dropl-mcp login` again.");
      throw new DeviceLoginError("failed", `Sign-in failed: ${error.message} (${error.code})`);
    }
  }
}
