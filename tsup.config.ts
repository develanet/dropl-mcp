import { defineConfig } from "tsup";

/*
 * One self-contained ESM file. `@dropl/shared` is private and never published, so it's bundled;
 * the runtime dependencies in package.json stay external and are installed by npm.
 */
export default defineConfig({
  entry: { cli: "src/cli.ts" },
  format: ["esm"],
  platform: "node",
  target: "node22",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  splitting: false,
  dts: false,
  noExternal: ["@dropl/shared"],
});
