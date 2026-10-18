import { defineConfig } from "tsup"
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  target: "node20",
  external: ["@opencode-ai/plugin"],
  // Self-contained bundle so "copy dist/index.js into the plugins dir" works.
  noExternal: ["zod", "jsonc-parser"],
  // jsonc-parser's default UMD main breaks when bundled; prefer its ESM build.
  esbuildOptions(options) { options.mainFields = ["module", "main"] },
})
