#!/usr/bin/env node
/*
 * Stages the MCP Bundle (.mcpb) for Claude Desktop and Smithery in build/mcpb: manifest.json, icon.png, LICENSE,
 * a dependency-free package.json, and server/index.js, one ESM file with every dependency bundled (no
 * node_modules to ship). `pnpm bundle` then validates the staged manifest and packs build/dropl.mcpb.
 *
 * server/index.js sits one level below package.json, the same layout as dist/cli.js, because src/version.ts
 * reads the version from "../package.json" at startup.
 */
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "tsup";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const stagingUrl = new URL("../build/mcpb/", import.meta.url);
const stagingDirectory = fileURLToPath(stagingUrl);
const SERVER_DIRECTORY_NAME = "server";
const SERVER_ENTRY_NAME = "index";
const COPIED_FILES = ["manifest.json", "icon.png", "LICENSE"];

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));

if (manifest.version !== packageJson.version) {
  console.error(`manifest.json is at ${manifest.version}, package.json at ${packageJson.version}. Bump manifest.json's version first.`);
  process.exit(1);
}
const expectedEntryPoint = `${SERVER_DIRECTORY_NAME}/${SERVER_ENTRY_NAME}.js`;
if (manifest.server?.entry_point !== expectedEntryPoint) {
  console.error(`manifest.json server.entry_point must be "${expectedEntryPoint}", the file this script builds.`);
  process.exit(1);
}

await rm(stagingDirectory, { recursive: true, force: true });
await mkdir(new URL(`${SERVER_DIRECTORY_NAME}/`, stagingUrl), { recursive: true });

await build({
  config: false,
  entry: { [SERVER_ENTRY_NAME]: `${packageRoot}src/cli.ts` },
  format: ["esm"],
  platform: "node",
  target: "node20",
  outDir: fileURLToPath(new URL(`${SERVER_DIRECTORY_NAME}/`, stagingUrl)),
  clean: false,
  sourcemap: false,
  splitting: false,
  dts: false,
  silent: true,
  noExternal: [/.*/],
  // CommonJS dependencies call require() for Node built-ins, which an ESM bundle doesn't define on its own.
  banner: { js: 'import { createRequire as __droplCreateRequire } from "node:module";\nconst require = __droplCreateRequire(import.meta.url);' },
});

const bundlePackageJson = {
  name: packageJson.name,
  version: packageJson.version,
  description: packageJson.description,
  license: packageJson.license,
  author: packageJson.author,
  homepage: packageJson.homepage,
  repository: packageJson.repository,
  type: "module",
  main: expectedEntryPoint,
  engines: packageJson.engines,
};
await writeFile(new URL("package.json", stagingUrl), `${JSON.stringify(bundlePackageJson, null, 2)}\n`);
for (const fileName of COPIED_FILES) await copyFile(new URL(`../${fileName}`, import.meta.url), new URL(fileName, stagingUrl));

console.log(`Staged ${packageJson.name} ${packageJson.version} in ${stagingDirectory}`);
