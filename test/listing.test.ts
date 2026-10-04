import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { LONG_DESCRIPTION, REGISTRY_NAME, SERVER_TITLE, SHORT_DESCRIPTION, WEBSITE_URL } from "../src/metadata.js";
import { PACKAGE_NAME, PACKAGE_VERSION } from "../src/version.js";

const REGISTRY_DESCRIPTION_MAX_LENGTH = 100;
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
    expect(stdout).toContain(`server.json is at ${PACKAGE_VERSION}.`);
  });

  it("repeats the canonical copy word for word in the README", async () => {
    const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
    expect(readme).toContain(SHORT_DESCRIPTION);
    expect(readme).toContain(LONG_DESCRIPTION);
  });
});
