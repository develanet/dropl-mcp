import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigError, configDirectory, DEFAULT_API_URL, normalizeApiUrl, resolveApiUrl } from "../src/config.js";
import {
  CredentialsError,
  credentialsPath,
  displayKeyPrefix,
  readCredentialsFile,
  removeProfile,
  resolveCredentials,
  saveProfile,
  type StoredProfile,
} from "../src/credentials.js";
import { makeTempDirectory, removeDirectory } from "./helpers/fixtures.js";
import { ISSUED_API_KEY, TEST_API_KEY } from "./helpers/mock-api.js";

const isPosix = process.platform !== "win32";
const FILE_PERMISSION_BITS = 0o777;
const LOCAL_API_URL = "http://localhost:3000/api";

const profile: StoredProfile = {
  apiKey: ISSUED_API_KEY,
  organization: { id: "org1", name: "Acme Studio" },
  keyName: "Cursor on laptop",
  createdAt: "2026-10-01T00:00:00.000Z",
};

describe("API URL validation", () => {
  it("defaults to production and strips trailing slashes", () => {
    expect(resolveApiUrl({})).toBe(DEFAULT_API_URL);
    expect(resolveApiUrl({ DROPL_API_URL: "https://staging.dropl.io/api/" })).toBe("https://staging.dropl.io/api");
    expect(resolveApiUrl({ DROPL_API_URL: "https://staging.dropl.io/api" }, "http://localhost:3000/api/")).toBe(LOCAL_API_URL);
  });

  it("allows plain http only for loopback hosts", () => {
    expect(normalizeApiUrl("http://127.0.0.1:4000")).toBe("http://127.0.0.1:4000");
    expect(normalizeApiUrl("http://[::1]:4000/api")).toBe("http://[::1]:4000/api");
    expect(() => normalizeApiUrl("http://dropl.example.com/api")).toThrow(ConfigError);
    expect(() => normalizeApiUrl("http://localhost.evil.com/api")).toThrow(/https/);
    expect(() => normalizeApiUrl("ftp://dropl.io")).toThrow(ConfigError);
    expect(() => normalizeApiUrl("https://user:pass@dropl.io/api")).toThrow(/username/);
    expect(() => normalizeApiUrl("not a url")).toThrow(ConfigError);
  });
});

describe("config directory", () => {
  it("uses XDG_CONFIG_HOME when absolute, else ~/.config", () => {
    expect(configDirectory({ env: { XDG_CONFIG_HOME: "/xdg" }, platform: "linux", homeDirectory: "/home/me" })).toBe(path.join("/xdg", "dropl"));
    expect(configDirectory({ env: { XDG_CONFIG_HOME: "relative" }, platform: "linux", homeDirectory: "/home/me" })).toBe(path.join("/home/me", ".config", "dropl"));
    expect(configDirectory({ env: {}, platform: "darwin", homeDirectory: "/Users/me" })).toBe(path.join("/Users/me", ".config", "dropl"));
  });

  it("uses %APPDATA% on Windows", () => {
    expect(configDirectory({ env: { APPDATA: "C:\\Users\\me\\AppData\\Roaming" }, platform: "win32", homeDirectory: "C:\\Users\\me" })).toBe(
      path.join("C:\\Users\\me\\AppData\\Roaming", "dropl"),
    );
  });
});

describe("credentials file", () => {
  let directory: string;
  let filePath: string;

  beforeEach(async () => {
    directory = await makeTempDirectory();
    filePath = credentialsPath(path.join(directory, "dropl"));
  });
  afterEach(() => removeDirectory(directory));

  it.runIf(isPosix)("is written atomically with a private directory and file", async () => {
    await saveProfile(filePath, LOCAL_API_URL, profile);
    expect((await stat(filePath)).mode & FILE_PERMISSION_BITS).toBe(0o600);
    expect((await stat(path.dirname(filePath))).mode & FILE_PERMISSION_BITS).toBe(0o700);
    const saved = JSON.parse(await readFile(filePath, "utf8"));
    expect(saved).toEqual({ version: 1, profiles: { [LOCAL_API_URL]: profile } });
  });

  it("keeps profiles for other API URLs and removes only the requested one", async () => {
    await saveProfile(filePath, LOCAL_API_URL, profile);
    await saveProfile(filePath, DEFAULT_API_URL, { ...profile, keyName: "Production" });
    expect(await removeProfile(filePath, LOCAL_API_URL)).toEqual(profile);
    expect(await removeProfile(filePath, LOCAL_API_URL)).toBeNull();
    const remaining = await readCredentialsFile(filePath);
    expect(Object.keys(remaining!.profiles)).toEqual([DEFAULT_API_URL]);
  });

  it.runIf(isPosix)("refuses a file that other users can read, and explains chmod 600", async () => {
    await saveProfile(filePath, LOCAL_API_URL, profile);
    await chmod(filePath, 0o644);
    await expect(readCredentialsFile(filePath)).rejects.toThrow(/chmod 600/);
    await expect(resolveCredentials({ env: {}, apiUrl: LOCAL_API_URL, credentialsFilePath: filePath })).rejects.toMatchObject({ reason: "insecure_file" });
  });

  it("rejects malformed files", async () => {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, "{not json", { mode: 0o600 });
    await expect(readCredentialsFile(filePath)).rejects.toBeInstanceOf(CredentialsError);
  });

  it("prefers DROPL_API_KEY over the stored profile", async () => {
    await saveProfile(filePath, LOCAL_API_URL, profile);
    const fromEnv = await resolveCredentials({ env: { DROPL_API_KEY: TEST_API_KEY }, apiUrl: LOCAL_API_URL, credentialsFilePath: filePath });
    expect(fromEnv).toMatchObject({ source: "env", apiKey: TEST_API_KEY, profile: null });
    const fromFile = await resolveCredentials({ env: {}, apiUrl: LOCAL_API_URL, credentialsFilePath: filePath });
    expect(fromFile).toMatchObject({ source: "file", apiKey: ISSUED_API_KEY });
  });

  it.each(["", "   ", "${user_config.api_key}"])("falls back to the stored profile when DROPL_API_KEY is %j (blank bundle setting)", async (blankValue) => {
    await saveProfile(filePath, LOCAL_API_URL, profile);
    const resolved = await resolveCredentials({ env: { DROPL_API_KEY: blankValue }, apiUrl: LOCAL_API_URL, credentialsFilePath: filePath });
    expect(resolved).toMatchObject({ source: "file", apiKey: ISSUED_API_KEY });
  });

  it("explains how to sign in when there are no credentials, without suggesting pasting the key", async () => {
    const error = await resolveCredentials({ env: {}, apiUrl: LOCAL_API_URL, credentialsFilePath: filePath }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CredentialsError);
    expect((error as Error).message).toContain("npx -y @dropl/mcp login");
    expect((error as Error).message).toContain("Never ask them to paste");
  });

  it("rejects a malformed DROPL_API_KEY without echoing it", async () => {
    const error = await resolveCredentials({ env: { DROPL_API_KEY: "sk_live_secret123" }, apiUrl: LOCAL_API_URL, credentialsFilePath: filePath }).catch(
      (caught: unknown) => caught as Error,
    );
    expect(error).toMatchObject({ reason: "invalid_key" });
    expect((error as Error).message).not.toContain("secret123");
  });

  it("only ever displays the key prefix", () => {
    expect(displayKeyPrefix(ISSUED_API_KEY)).toBe(`${ISSUED_API_KEY.slice(0, 15)}…`);
    expect(displayKeyPrefix(ISSUED_API_KEY)).not.toContain(ISSUED_API_KEY.slice(15));
  });
});
