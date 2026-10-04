import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { LONG_DESCRIPTION, REGISTRY_NAME, SERVER_TITLE, SHORT_DESCRIPTION, WEBSITE_URL } from "../src/metadata.js";
import { PACKAGE_NAME, PACKAGE_VERSION } from "../src/version.js";
import { makeTempDirectory, removeDirectory } from "./helpers/fixtures.js";

const REGISTRY_DESCRIPTION_MAX_LENGTH = 100;
const VERSIONED_FILES = ["server.json", "manifest.json", "plugin.json"];
const BUMPED_VERSION = "99.0.0";
const MIRROR_REPOSITORY_URL = "https://github.com/develanet/dropl-mcp";
const readJson = async (relativePath: string) => JSON.parse(await readFile(new URL(relativePath, import.meta.url), "utf8"));

describe("listing metadata", () => {
  it("keeps package.json, server.json, and the running server on one version and one description", async () => {
    const packageJson = await readJson("../package.json");
    const serverJson = await readJson("../server.json");

    expect(SHORT_DESCRIPTION.length).toBeLessThanOrEqual(REGISTRY_DESCRIPTION_MAX_LENGTH);
    expect(packageJson).toMatchObject({ name: PACKAGE_NAME, version: PACKAGE_VERSION, description: SHORT_DESCRIPTION, mcpName: REGISTRY_NAME, homepage: WEBSITE_URL });
    expect(packageJson.repository).toEqual({ type: "git", url: `git+${MIRROR_REPOSITORY_URL}.git` });
    expect(packageJson.bugs).toEqual({ url: `${MIRROR_REPOSITORY_URL}/issues` });
    expect(serverJson).toMatchObject({
      name: REGISTRY_NAME,
      title: SERVER_TITLE,
      description: SHORT_DESCRIPTION,
      websiteUrl: WEBSITE_URL,
      version: packageJson.version,
      repository: { url: MIRROR_REPOSITORY_URL, source: "github" },
    });
    expect(serverJson.packages).toEqual([
      expect.objectContaining({ registryType: "npm", identifier: PACKAGE_NAME, version: packageJson.version, transport: { type: "stdio" } }),
    ]);
    expect(serverJson.packages[0].environmentVariables).toEqual([
      { name: "DROPL_API_KEY", description: "Optional. Dropl API key; overrides the saved browser sign-in.", isRequired: false, isSecret: true },
    ]);
  });

  it("passes the release version check", async () => {
    const script = fileURLToPath(new URL("../scripts/sync-version.mjs", import.meta.url));
    const { stdout } = await promisify(execFile)(process.execPath, [script, "--check"]);
    for (const fileName of VERSIONED_FILES) expect(stdout).toContain(`${fileName} is at ${PACKAGE_VERSION}.`);
  });

  it("writes a release bump into server.json, manifest.json, and plugin.json", async () => {
    const directory = await makeTempDirectory();
    try {
      await mkdir(path.join(directory, "scripts"));
      await copyFile(fileURLToPath(new URL("../scripts/sync-version.mjs", import.meta.url)), path.join(directory, "scripts", "sync-version.mjs"));
      const packageJson = await readJson("../package.json");
      await writeFile(path.join(directory, "package.json"), JSON.stringify({ ...packageJson, version: BUMPED_VERSION }));
      for (const fileName of VERSIONED_FILES) await copyFile(fileURLToPath(new URL(`../${fileName}`, import.meta.url)), path.join(directory, fileName));
      const script = path.join(directory, "scripts", "sync-version.mjs");

      const check = await promisify(execFile)(process.execPath, [script, "--check"]).catch((error: { code: number; stderr: string }) => error);
      expect(check).toMatchObject({ code: 1 });
      for (const fileName of VERSIONED_FILES) expect((check as { stderr: string }).stderr).toContain(`${fileName} is at ${PACKAGE_VERSION}, package.json at ${BUMPED_VERSION}.`);

      await promisify(execFile)(process.execPath, [script]);
      const written = async (fileName: string) => JSON.parse(await readFile(path.join(directory, fileName), "utf8"));
      const serverJson = await written("server.json");
      expect(serverJson.version).toBe(BUMPED_VERSION);
      expect(serverJson.packages[0].version).toBe(BUMPED_VERSION);
      expect((await written("manifest.json")).version).toBe(BUMPED_VERSION);
      expect((await written("plugin.json")).version).toBe(BUMPED_VERSION);
      // Only the version changes: the rest of each file is rewritten byte for byte.
      for (const fileName of VERSIONED_FILES) {
        const original = await readFile(new URL(`../${fileName}`, import.meta.url), "utf8");
        expect(await readFile(path.join(directory, fileName), "utf8")).toBe(original.replaceAll(`"version": "${PACKAGE_VERSION}"`, `"version": "${BUMPED_VERSION}"`));
      }
    } finally {
      await removeDirectory(directory);
    }
  });

  it("repeats the canonical copy word for word in the README", async () => {
    const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
    expect(readme).toContain(SHORT_DESCRIPTION);
    expect(readme).toContain(LONG_DESCRIPTION);
  });
});
