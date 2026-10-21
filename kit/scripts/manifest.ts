// The kit's dependency set (plans/apps.md §3.1, minus maps and 3D) as the
// IMPORT MAP the app build resolves bare specifiers against: one entry per
// specifier an app may import, built into one browser bundle each by
// scripts/build-vendor.mjs, with everything they share in common chunks —
// one React, one react-query, one radix, one zod on the page.
//
// A new specifier here is a new kit version. `@/…` entries are the kit's own
// shadcn components (the app's `src/` shadows them, §2.1); `@strut/kit` is the
// kit itself.

/** The packages pinned in package.json whose versions the manifest records. */
export const PACKAGES = [
  "react", "react-dom",
  "radix-ui", "lucide-react", "class-variance-authority", "clsx", "tailwind-merge",
  "vaul", "react-day-picker", "react-resizable-panels", "sonner", "cmdk",
  "react-router", "zustand", "immer",
  "recharts", "d3", "@xyflow/react",
  "motion",
  "@tanstack/react-query", "@tanstack/react-table", "@tanstack/react-virtual",
  "@dnd-kit/core", "@dnd-kit/sortable", "@dnd-kit/utilities", "@dnd-kit/modifiers",
  "date-fns", "lodash", "zod", "react-hook-form", "@hookform/resolvers",
  "papaparse", "mathjs", "simple-statistics", "fuse.js",
  "react-markdown", "remark-gfm",
  "@modelcontextprotocol/ext-apps",
];

/** Bare specifiers → bundled as JS entries. Order is cosmetic. */
export const JS_ENTRIES = [
  "react", "react/jsx-runtime", "react/jsx-dev-runtime", "react-dom", "react-dom/client",
  "radix-ui", "lucide-react", "class-variance-authority", "clsx", "tailwind-merge",
  "vaul", "react-day-picker", "react-resizable-panels", "sonner", "cmdk",
  "react-router", "zustand", "zustand/middleware", "immer",
  "recharts", "d3", "@xyflow/react",
  "motion", "motion/react",
  "@tanstack/react-query", "@tanstack/react-table", "@tanstack/react-virtual",
  "@dnd-kit/core", "@dnd-kit/sortable", "@dnd-kit/utilities", "@dnd-kit/modifiers",
  "date-fns", "lodash", "zod", "react-hook-form", "@hookform/resolvers/zod",
  "papaparse", "mathjs", "simple-statistics", "fuse.js",
  "react-markdown", "remark-gfm",
];

/** The entries whose package is CommonJS. esbuild cannot enumerate a CJS
 *  module's exports, so an entry built straight from one is `export default
 *  module.exports` and `import { useState } from "react"` finds nothing;
 *  these get an ESM FACADE naming every key the module has at build time
 *  (`writeFacade`, build-vendor.ts). vendor.test.ts fails on any other entry
 *  that comes out with no named exports. */
export const CJS_ENTRIES = ["react", "react/jsx-runtime", "react/jsx-dev-runtime", "react-dom", "react-dom/client", "lodash", "papaparse"];

/** Stylesheets an app imports by specifier (`import "@xyflow/react/dist/style.css"`). */
export const CSS_ENTRIES = [
  "@xyflow/react/dist/style.css", "@xyflow/react/dist/base.css",
  "react-day-picker/style.css",
];

/** A specifier models write by reflex → the entry it means. */
export const ALIASES: Record<string, string> = {
  "framer-motion": "motion/react",
  "react-router-dom": "react-router",
};

/** The kit's own entries: specifier → source file. */
export const KIT_ENTRIES: Record<string, string> = {
  "@strut/kit": "src/index.ts",
  "@strut/kit/bootstrap": "src/bootstrap.ts",
  "@/lib/utils": "src/lib/utils.ts",
  "@/hooks/use-mobile": "src/hooks/use-mobile.ts",
  "@/hooks/use-theme": "src/hooks/use-theme.ts",
};

/** The output name (no extension) for a specifier: `@tanstack/react-query` →
 *  `tanstack__react-query`, `@/components/ui/button` → `ui/button`. */
export function outName(specifier: string): string {
  if (specifier.startsWith("@/components/")) return specifier.slice("@/components/".length);
  if (specifier.startsWith("@/")) return specifier.slice(2);
  return specifier.replace(/^@/, "").replace(/\//g, "__").replace(/\.css$/, "");
}
