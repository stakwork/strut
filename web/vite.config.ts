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

// `STRUT_DEV_INDEX=https://index.stakwork.ai npm run dev`: the store front
// (`?store=1`) of this checkout over a deployed index's open reads.
const index = process.env.STRUT_DEV_INDEX;

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
      // The wallet contract and its relay (specs/WALLET.md): the same, pure TS.
      "@strut/kit/wallet": fileURLToPath(new URL("../kit/src/wallet/index.ts", import.meta.url)),
      // The channels contract and the relay a browser host runs (plans/app-channels.md).
      "@strut/kit/channels": fileURLToPath(new URL("../kit/src/channels/index.ts", import.meta.url)),
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
      // The brand hosted apps are shown in (src/brand.ts).
      "/brand": "http://localhost:3000",
      "/runs": "http://localhost:3000",
      // Packages: the catalog this strut publishes, its channels, and what
      // it installed or follows (specs/API.md §16).
      "/packages": "http://localhost:3000",
      "/publisher": "http://localhost:3000",
      // Paid runs: Earnings, the wallet, Add sats, Withdraw; the rate; the
      // credit held at other struts; the Public view and what it serves.
      "/earnings": "http://localhost:3000",
      "/rate": "http://localhost:3000",
      "/remote": "http://localhost:3000",
      "/public-view": "http://localhost:3000",
      "/public": "http://localhost:3000",
      // The index role's open reads: the store front (`?store=1`).
      "/index": index ? { target: index, changeOrigin: true } : "http://localhost:3000",
      // Model downloads are SSE; /audio/stream is a WebSocket.
      "/audio": { target: "http://localhost:3000", ws: true, configure: sseConfigure },
      // An app's channel socket (plans/app-channels.md): a WebSocket.
      "/channels": { target: "http://localhost:3000", ws: true },
    },
  },
  build: {
    outDir: "dist",
  },
});
