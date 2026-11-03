#!/usr/bin/env node
/**
 * Preview an app of a live strut (a swarm's lab) on THIS checkout, against
 * that strut's real data, before anything is merged or deployed:
 *
 *   LAB_KEY=… node scripts/preview-app.mjs --lab https://<swarm>:3355/lab --app <name> [--allow a/b,c/d] [--watch]
 *
 * It downloads the app's source (its active version, or `--version vN`),
 * boots a local strut from this checkout — bound to 127.0.0.1, a throwaway
 * workspace, the filesystem backend — publishes the app there (a stand-in
 * for each workflow its manifest grants, so it builds), and serves it
 * through a proxy on `--port` (4317): the page, its build and its own state
 * (`app/*`) are the local strut's, so `strut/views` and the kit are this
 * checkout's; an app's READ of data (`step_run` of a step on the allowlist:
 * the run reads, the graph reads, `sheets/get-values`, and whatever
 * `--allow` adds — the app's own read steps) is answered by the live strut
 * (`POST <lab>/steps/<type>/run`, the key from LAB_KEY). Anything else — a
 * launch, a write, a step not on the list — is refused in the proxy and
 * never leaves the machine. Nothing it reads is stored. The app's grants
 * are not checked here: the reads go out with the deployment key.
 *
 * A read step this checkout has and a live strut may not yet (`COMPUTED`:
 * `run/provenance`) is answered HERE by this checkout's code, over what the
 * live strut serves (the run's log and its agents' transcripts), kept in
 * memory a few minutes so a second spot check of the same run is quick.
 *
 * `--app-dir <dir>`: keep the source there (downloaded when it holds no
 * app.yaml, used as it is when it does — edit it and republish). `--watch`:
 * a change under the app's source republishes it; one under
 * src/apps/views/src or kit/src restarts the local strut (rebuilding the
 * kit's vendor layer first for kit/src) and republishes, since strut/views
 * is seeded at boot and an app resolves the kit through kit/vendor.
 */
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, watch, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The steps an app reads data with, answered by the live strut. Nothing that launches, writes or spends. */
export const CORE_READS = [
  "run/get",
  "run/list",
  "run/events",
  "run/transcript",
  "run/workflow",
  "run/files",
  "graph/graph-get",
  "graph/graph-get-batched",
  "graph/graph-edges",
  "graph/graph-neighbors",
  "graph/graph-search",
  "graph/find",
  "graph/get-ontology",
  "graph/get-ontology-type",
  "graph/changes",
  "sheets/get-values",
];

/** Read steps answered here, by this checkout's code over the live strut's reads (a live strut may not have them yet). */
export const COMPUTED = ["run/provenance"];

/** Where an app's `step_run` of `type` goes: its own state stays local, a computed read is answered here, a read on the list goes to the live strut, the rest is refused. */
export function classify(type, allow) {
  if (type.startsWith("app/")) return "local";
  if (COMPUTED.includes(type)) return "computed";
  return allow.has(type) ? "remote" : "refuse";
}

/** A run's RAW log from the live strut: its events, each agent's transcript put back on its step.end (the route hands out links). */
const rawLogs = new Map();
async function rawLog(labBase, key, workflow, runId) {
  const id = `${workflow}/${runId}`;
  const hit = rawLogs.get(id);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.events;
  const get = async (path) => {
    const r = await fetch(`${labBase}${path}`, { headers: { "x-api-token": key, authorization: `Bearer ${key}` } });
    if (!r.ok) throw new Error(`GET ${path}: ${r.status} ${(await r.text()).slice(0, 200)}`);
    return r.json();
  };
  const events = await get(`/workflows/${encodeURIComponent(workflow)}/runs/${encodeURIComponent(runId)}/events`);
  for (const e of events) {
    if (e.type !== "step.end" || typeof e.transcript !== "string") continue;
    e.messages = await get(e.transcript);
    delete e.transcript;
  }
  rawLogs.set(id, { at: Date.now(), events });
  return events;
}

/** A COMPUTED step, answered here. */
async function runComputed(labBase, key, type, config = {}) {
  if (type !== "run/provenance") throw new Error(`${type} is not computed here`);
  const { workflow, runId, ...subject } = config;
  if (typeof workflow !== "string" || typeof runId !== "string") throw new Error("run/provenance needs `workflow` and `runId`");
  const { tsImport } = await import("tsx/esm/api");
  const { buildProvenance } = await tsImport(join(ROOT, "src/provenance.ts"), import.meta.url);
  const events = await rawLog(labBase, key, workflow, runId);
  const out = buildProvenance(events, subject);
  return { ok: true, bytes: JSON.stringify(out).length, call: result(out) };
}

/** A JSON-RPC body that is one `tools/call` of `step_run` → its id and arguments; anything else null. */
export function stepRunCall(body) {
  let msg;
  try {
    msg = JSON.parse(body);
  } catch {
    return null;
  }
  if (!msg || Array.isArray(msg) || msg.method !== "tools/call" || msg.params?.name !== "step_run") return null;
  const args = msg.params.arguments ?? {};
  if (typeof args.type !== "string") return null;
  return { id: msg.id, type: args.type, config: args.config, input: args.input };
}

const result = (output) => ({ content: [{ type: "text", text: JSON.stringify(output ?? null) }] });
const refusal = (message) => ({ content: [{ type: "text", text: JSON.stringify({ error: message }) }], isError: true });

/** One step on the live strut: its output, or an error `step_run` shows the page. */
async function runRemote(lab, key, type, config, input) {
  const r = await fetch(`${lab}/steps/${type}/run`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-token": key, authorization: `Bearer ${key}` },
    body: JSON.stringify({ ...(config ? { config } : {}), ...(input !== undefined ? { input } : {}) }),
  });
  const text = await r.text();
  let out;
  try {
    out = JSON.parse(text);
  } catch {
    return { ok: false, bytes: text.length, call: refusal(`${type}: the live strut answered ${r.status}: ${text.slice(0, 200)}`) };
  }
  if (r.ok && out.status === "success") return { ok: true, bytes: text.length, call: result(out.output) };
  const message = out.error?.message ?? (typeof out.error === "string" ? out.error : `${type} failed (${r.status})`);
  return { ok: false, bytes: text.length, call: refusal(message) };
}

/**
 * The proxy: everything to `upstream` (the local strut) as it is, except a
 * `tools/call` of `step_run` on `/mcp`, answered here — remote, refused, or
 * passed on for `app/*`.
 */
export function createProxy({ upstream, lab, key, allow, log = () => {} }) {
  const up = new URL(upstream);
  const forward = (req, res, body) => {
    const headers = { ...req.headers, host: up.host };
    if (body !== undefined) headers["content-length"] = Buffer.byteLength(body);
    const p = http.request({ hostname: up.hostname, port: up.port, path: req.url, method: req.method, headers }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    p.on("error", (e) => {
      res.writeHead(502, { "content-type": "text/plain" });
      res.end(`the local strut is unreachable: ${e.message}`);
    });
    if (body !== undefined) p.end(body);
    else req.pipe(p);
  };
  const reply = (res, id, call) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id, result: call }));
  };
  return http.createServer((req, res) => {
    if (req.method !== "POST" || !(req.url ?? "").split("?")[0].endsWith("/mcp")) return forward(req, res);
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const call = stepRunCall(body);
      const where = call ? classify(call.type, allow) : "local";
      if (!call || where === "local") return forward(req, res, body);
      if (where === "refuse") {
        log(`refused ${call.type}`);
        return reply(res, call.id, refusal(`${call.type}: refused in the local preview — it only reads from the live strut, never launches or writes (--allow adds a read step)`));
      }
      const started = Date.now();
      try {
        const out = where === "computed" ? await runComputed(lab, key, call.type, call.config) : await runRemote(lab, key, call.type, call.config, call.input);
        log(`${call.type} ${out.ok ? "ok" : "FAILED"} ${Date.now() - started}ms ${(out.bytes / 1024).toFixed(1)}KB`);
        reply(res, call.id, out.call);
      } catch (e) {
        log(`${call.type} unreachable: ${e.message}`);
        reply(res, call.id, refusal(`${call.type}: the live strut is unreachable (${e.message})`));
      }
    });
  });
}

// ── The run ────────────────────────────────────────────────────────────────

const say = (m) => console.log(`[preview] ${m}`);
const fail = (m) => {
  console.error(`[preview] ${m}`);
  process.exit(1);
};

async function lab(base, key, path) {
  const r = await fetch(`${base}${path}`, { headers: { "x-api-token": key, authorization: `Bearer ${key}` } });
  if (!r.ok) throw new Error(`GET ${path}: ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r;
}

/** The app's source (no dist/) from the live strut into `dir`. */
async function download(base, key, app, version, dir) {
  const v = version ?? (await (await lab(base, key, `/apps/${app}`)).json()).version;
  const listing = await (await lab(base, key, `/apps/${app}/${v}/files`)).json();
  const files = (listing.files ?? []).map((f) => (typeof f === "string" ? f : f.path)).filter((p) => p && !p.startsWith("dist/"));
  for (const path of files) {
    const target = join(dir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, Buffer.from(await (await lab(base, key, `/apps/${app}/${v}/files/${path}`)).arrayBuffer()));
  }
  return { version: v, files: files.length };
}

function readTree(dir) {
  const files = {};
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const rel = relative(dir, p);
      if (rel === "dist" || name === "node_modules" || name === ".git") continue;
      if (statSync(p).isDirectory()) walk(p);
      else files[rel] = readFileSync(p, "utf8");
    }
  };
  walk(dir);
  return files;
}

/** The workflows a manifest grants, read off app.yaml's `grants.workflows` (a flow list or a block list). */
export function grantedWorkflows(yamlText) {
  const flow = yamlText.match(/^\s+workflows:\s*\[([^\]]*)\]/m);
  if (flow) return flow[1].split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
  const block = yamlText.match(/^(\s+)workflows:\s*\n((?:\1\s+-.*\n?)*)/m);
  return block ? [...block[2].matchAll(/-\s*["']?([^"'\s#]+)/g)].map((m) => m[1]) : [];
}

async function main() {
  const { values } = parseArgs({
    options: {
      lab: { type: "string" },
      app: { type: "string" },
      version: { type: "string" },
      allow: { type: "string", default: "" },
      "app-dir": { type: "string" },
      port: { type: "string", default: "4317" },
      "strut-port": { type: "string", default: "3317" },
      watch: { type: "boolean", default: false },
    },
  });
  const key = process.env.LAB_KEY;
  if (!values.lab || !values.app || !key) fail("usage: LAB_KEY=… node scripts/preview-app.mjs --lab https://<swarm>:3355/lab --app <name> [--version vN] [--allow a/b,c/d] [--app-dir <dir>] [--port 4317] [--strut-port 3317] [--watch]");
  const base = values.lab.replace(/\/+$/, "");
  const app = values.app;
  if (!existsSync(join(ROOT, "kit/vendor/import-map.json")) || !existsSync(join(ROOT, "web/dist/index.html"))) {
    fail("this checkout has no built kit or UI — run `yarn install` first (its prepare builds both)");
  }

  const home = join(tmpdir(), "strut-preview", app);
  const appDir = resolve(values["app-dir"] ?? join(home, "app"));
  const workspace = join(home, "workspace");
  mkdirSync(appDir, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  if (existsSync(join(appDir, "app.yaml"))) say(`using the source in ${appDir}`);
  else {
    const got = await download(base, key, app, values.version, appDir);
    say(`downloaded ${app} ${got.version} (${got.files} files) into ${appDir}`);
  }

  // The local strut: this checkout, localhost only, no key of ours in its env.
  const strutPort = Number(values["strut-port"]);
  const local = `http://127.0.0.1:${strutPort}`;
  const strutLog = join(home, "strut.log");
  let child = null;
  const startStrut = () =>
    new Promise((ok, no) => {
      const env = { ...process.env, STRUT_HOST: "127.0.0.1", STRUT_PORT: String(strutPort), STRUT_WORKSPACE: workspace, STRUT_WORKSPACE_BACKEND: "fs", STRUT_SECRET_KEY: randomBytes(24).toString("hex") };
      delete env.LAB_KEY;
      delete env.STRUT_API_KEY;
      child = spawn(join(ROOT, "node_modules/.bin/tsx"), ["src/server.ts"], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
      const out = createWriteStream(strutLog, { flags: "a" });
      child.stderr.pipe(out);
      let ready = false;
      child.stdout.on("data", (chunk) => {
        out.write(chunk);
        if (!ready && String(chunk).includes('"event":"ready"')) {
          ready = true;
          ok();
        }
      });
      child.on("exit", (code) => {
        if (!ready) no(new Error(`the local strut exited (${code}) before it was ready — see ${strutLog}`));
      });
    });
  const stopStrut = () =>
    new Promise((ok) => {
      if (!child || child.exitCode !== null) return ok();
      child.once("exit", () => ok());
      child.kill("SIGTERM");
    });

  const standIns = async () => {
    const listed = await (await fetch(`${local}/workflows`)).json();
    const have = new Set((Array.isArray(listed) ? listed : (listed.workflows ?? [])).map((w) => w.name));
    for (const name of grantedWorkflows(readFileSync(join(appDir, "app.yaml"), "utf8"))) {
      if (have.has(name)) continue;
      await fetch(`${local}/workflows`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, description: "a local preview's stand-in: the real one runs on the live strut", steps: [{ id: "noop", type: "transform", config: { value: 1 } }] }),
      });
    }
  };
  // Every publish is a new version (the stamp), so a change to strut/views alone still rebuilds the app.
  const publish = async () => {
    const files = { ...readTree(appDir), "preview-stamp.txt": new Date().toISOString() };
    const r = await fetch(`${local}/apps`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: app, files }) });
    const out = await r.json();
    if (!r.ok) return say(`the app did not build:\n  ${(out.errors ?? [out.error]).join("\n  ")}`);
    say(`published ${app} ${out.version}${out.warnings?.length ? ` (${out.warnings.length} warnings)` : ""}`);
  };

  say(`starting the local strut on ${local} (its log: ${strutLog})`);
  await startStrut();
  await standIns();
  await publish();

  const allow = new Set([...CORE_READS, ...values.allow.split(",").map((s) => s.trim()).filter(Boolean)]);
  const port = Number(values.port);
  const proxy = createProxy({ upstream: local, lab: base, key, allow, log: (m) => say(m) });
  await new Promise((ok) => proxy.listen(port, "127.0.0.1", ok));
  say(`open http://localhost:${port}/?app=${encodeURIComponent(app)} — reads from ${base}, nothing launched or written there`);

  if (values.watch) {
    let timer = null;
    let pending = { restart: false, kit: false };
    const flush = async () => {
      const { restart, kit } = pending;
      pending = { restart: false, kit: false };
      if (kit) {
        say("kit/src changed: rebuilding kit/vendor");
        spawnSync(process.execPath, ["scripts/build-kit.mjs"], { cwd: ROOT, stdio: "ignore" });
      }
      if (restart) {
        say("restarting the local strut");
        await stopStrut();
        await startStrut();
      }
      await publish();
    };
    const on = (dir, what) =>
      watch(dir, { recursive: true }, (_event, file) => {
        if (file && /(^|\/)(node_modules|dist)(\/|$)/.test(String(file))) return;
        if (what !== "app") pending.restart = true;
        if (what === "kit") pending.kit = true;
        clearTimeout(timer);
        timer = setTimeout(() => void flush().catch((e) => say(String(e))), 400);
      });
    on(appDir, "app");
    on(join(ROOT, "src/apps/views/src"), "views");
    on(join(ROOT, "kit/src"), "kit");
    say("watching the app's source, src/apps/views/src and kit/src");
  }

  const quit = async () => {
    proxy.close();
    await stopStrut();
    process.exit(0);
  };
  process.on("SIGINT", quit);
  process.on("SIGTERM", quit);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
}
