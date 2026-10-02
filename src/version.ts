import { createRequire } from "node:module";

const requireFromHere = createRequire(import.meta.url);

/** `src/` (tests) and `dist/` (the bundle) both sit one level below the package root. */
export const PACKAGE_VERSION: string = (requireFromHere("../package.json") as { version: string }).version;
export const PACKAGE_NAME = "@dropl/mcp";
export const USER_AGENT = `dropl-mcp/${PACKAGE_VERSION}`;
