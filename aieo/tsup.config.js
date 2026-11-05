// The npm package `aieo`, built from strut's own source (../src/aieo, which
// strut compiles and tests as part of itself). Run from this folder:
// `npm run build` here, or `npm run build:aieo` at strut's root. The inlined
// SDKs come from strut's install, so they are the copies strut's tests ran.
// A plain object, not `defineConfig`: tsup runs from npx's cache, so this
// file cannot import it.
export default {
  entry: { index: "../src/aieo/index.ts" },
  format: ["esm"], // ESM only — ai v7 dropped CommonJS
  dts: true, // Generate declaration file (.d.ts)
  tsconfig: "tsconfig.json",
  splitting: false,
  sourcemap: true,
  clean: true,
  noExternal: [
    "@ai-sdk/anthropic",
    "@ai-sdk/google",
    "@ai-sdk/openai",
    "@ai-sdk/provider-utils",
  ], // Bundle AI SDK dependencies to avoid version conflicts
};
