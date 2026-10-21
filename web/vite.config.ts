import { defineConfig } from "vite";
import preact from "@preact/preset-vite";
import { fileURLToPath } from "node:url";

// Pass SSE responses through unbuffered so events stream in real time.
const sseConfigure = (proxy: any) => {
  proxy.on("proxyRes", (proxyRes: any) => {
    if (proxyRes.headers["content-type"]?.includes("text/event-stream")) {
      proxyRes.headers["cache-control"] = "no-cache";
      proxyRes.headers["x-accel-buffering"] = "no";
    }
  });
};

export default defineConfig({
  // Relative asset URLs so the built UI can be served from any mount path
  // (root or a sub-path like /lab) without a baked-in base. Pairs with the
  // runtime API-base derivation in src/api.ts. Requires the host to serve
  // the SPA at a trailing-slash path so relative assets resolve correctly.
  base: "./",
  plugins: [preact()],
  // react-diff-view is a React lib — alias React onto preact/compat so it
  // runs under Preact (the rest of the app stays vanilla Preact).
  resolve: {
    alias: {
      // The folds live in the kit (plans/apps.md §3): one copy, imported
      // from source — they are pure TS with no dependencies.
      "@strut/kit/folds": fileURLToPath(new URL("../kit/src/folds/index.ts", import.meta.url)),
      react: "preact/compat",
      "react-dom": "preact/compat",
      "react/jsx-runtime": "preact/jsx-runtime",
    },
  },
  server: {
    port: 5173,
    proxy: {
      // Disable buffering so SSE events (run streams + chat turn streams)
      // come through in real time.
      "/workflows": { target: "http://localhost:3000", configure: sseConfigure },
      "/chat": { target: "http://localhost:3000", configure: sseConfigure },
      "/steps": "http://localhost:3000",
      "/secrets": "http://localhost:3000",
      "/sessions": "http://localhost:3000",
      "/jobs": "http://localhost:3000",
      "/apps": "http://localhost:3000",
      // The app host's MCP client (src/app-host.ts): a page's tools/call,
      // relayed to strut's MCP door as it is. JSON-RPC over POST, answered
      // as SSE.
      "/mcp": { target: "http://localhost:3000", configure: sseConfigure },
      "/graph": "http://localhost:3000",
      "/health": "http://localhost:3000",
      "/llm": "http://localhost:3000",
      "/actor": "http://localhost:3000",
      "/peers": "http://localhost:3000",
      "/runs": "http://localhost:3000",
      // Model downloads are SSE; /audio/stream is a WebSocket.
      "/audio": { target: "http://localhost:3000", ws: true, configure: sseConfigure },
    },
  },
  build: {
    outDir: "dist",
  },
});
