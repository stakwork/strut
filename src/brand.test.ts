import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createStrut } from "./createStrut.js";
import { WorkspaceManager } from "./workspace.js";
import { MemoryRunStore } from "./store.js";
import { BRAND_FILE, brandProblem, brandStyles, normalizeBrand, readBrand, textOn, writeBrand } from "./brand.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("the brand record", () => {
  it("accepts a hex color, a length and a font list, and refuses anything else", () => {
    assert.equal(brandProblem({}), undefined);
    assert.equal(brandProblem({ color: "#0F766E", colorDark: "#2dd4bf", radius: "0.5rem", font: `"Avenir Next", system-ui, sans-serif` }), undefined);
    assert.equal(brandProblem({ color: "#abc", radius: "6px" }), undefined);
    assert.equal(brandProblem({ color: "", font: null }), undefined);
    assert.match(brandProblem({ logo: "x" })!, /unknown field "logo"/);
    assert.match(brandProblem({ color: "teal" })!, /color is a hex color/);
    assert.match(brandProblem({ color: "oklch(0.6 0.1 180)" })!, /color is a hex color/);
    assert.match(brandProblem({ radius: "1rem; color: red" })!, /radius is a length/);
    assert.match(brandProblem({ radius: "50%" })!, /radius is a length/);
    assert.match(brandProblem({ font: "Inter; }" })!, /font is a font-family list/);
    assert.match(brandProblem({ font: "url(x)" })!, /font is a font-family list/);
    assert.match(brandProblem({ color: 7 })!, /color is a string/);
    assert.match(brandProblem([])!, /the brand is/);
    assert.match(brandProblem(null)!, /the brand is/);
  });

  it("keeps a color as lowercase #rrggbb and drops empty fields", () => {
    assert.deepEqual(normalizeBrand({ color: "#ABC", colorDark: "", radius: " 4px ", font: null }), { color: "#aabbcc", radius: "4px" });
  });

  it("sets nothing for an empty brand", () => {
    assert.equal(brandStyles({}), null);
  });

  it("maps the color, its text, the ring, the radius and the font onto standard names, per theme", () => {
    const s = brandStyles({ color: "#0f766e", colorDark: "#5eead4", radius: "4px", font: "Georgia, serif" })!;
    assert.deepEqual(s.light.variables, {
      "--color-background-inverse": "#0f766e",
      "--color-text-inverse": "#ffffff",
      "--color-ring-primary": "#0f766e",
      "--border-radius-md": "4px",
      "--font-sans": "Georgia, serif",
    });
    assert.equal(s.dark.variables["--color-background-inverse"], "#5eead4");
    assert.equal(s.dark.variables["--color-text-inverse"], "#0a0a0a");
    // One color serves both themes when only one is set.
    assert.equal(brandStyles({ colorDark: "#5eead4" })!.light.variables["--color-background-inverse"], "#5eead4");
    // A radius alone leaves the colors to the kit.
    assert.deepEqual(brandStyles({ radius: "0" })!.dark.variables, { "--border-radius-md": "0" });
  });

  it("picks the text color that reads better", () => {
    assert.equal(textOn("#000000"), "#ffffff");
    assert.equal(textOn("#1e3a8a"), "#ffffff");
    assert.equal(textOn("#ffffff"), "#0a0a0a");
    assert.equal(textOn("#facc15"), "#0a0a0a");
    assert.equal(textOn("#fff"), "#0a0a0a");
  });

  it("every variable it sends is one the MCP Apps client accepts and the kit's stylesheet reads", async () => {
    const vars = brandStyles({ color: "#0f766e", radius: "4px", font: "Georgia" })!.light.variables;
    // The client checks the host's variables against the spec's list, and
    // refuses the whole context over one name it does not know.
    const req = createRequire(join(ROOT, "kit", "package.json"));
    const { McpUiHostContextSchema } = (await import(req.resolve("@modelcontextprotocol/ext-apps"))) as {
      McpUiHostContextSchema: { safeParse(v: unknown): { success: boolean } };
    };
    assert.equal(McpUiHostContextSchema.safeParse({ theme: "light", styles: { variables: vars } }).success, true);
    assert.equal(McpUiHostContextSchema.safeParse({ theme: "light", styles: { variables: { "--primary": "#0f766e" } } }).success, false);
    // `--font-sans` is Tailwind's own name; the rest the stylesheet maps.
    const css = await readFile(join(ROOT, "kit", "src", "styles", "base.css"), "utf8");
    for (const name of Object.keys(vars).filter((n) => n !== "--font-sans")) {
      assert.ok(css.includes(`var(${name},`), `base.css reads ${name}`);
    }
  });
});

describe("the brand file", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "strut-brand-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reads back what was written, and an empty brand removes the file", async () => {
    assert.deepEqual(await readBrand(dir), {});
    await writeBrand(dir, { color: "#0f766e" });
    assert.deepEqual(await readBrand(dir), { color: "#0f766e" });
    await writeBrand(dir, {});
    await assert.rejects(stat(join(dir, BRAND_FILE)), /ENOENT/);
    assert.deepEqual(await readBrand(dir), {});
  });
});

describe("the /brand routes", () => {
  const KEY = "brand-key";
  const PEER = "brand-peer";
  const auth = { authorization: `Bearer ${KEY}`, "content-type": "application/json" };
  let dir: string;
  let saved: Record<string, string | undefined>;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "strut-brand-routes-"));
    saved = { STRUT_API_KEY: process.env["STRUT_API_KEY"], STRUT_PEER_KEY: process.env["STRUT_PEER_KEY"] };
    process.env["STRUT_API_KEY"] = KEY;
    process.env["STRUT_PEER_KEY"] = PEER;
  });
  afterEach(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await rm(dir, { recursive: true, force: true });
  });

  const boot = () => createStrut({ workspace: new WorkspaceManager(join(dir, "ws")), store: new MemoryRunStore(), serveUi: false, scheduler: false, enableChat: false });

  it("a person sets the brand; every credential reads it; nothing else writes it", async () => {
    const strut = await boot();
    const get = async (headers: Record<string, string> = auth) => strut.app.request("/brand", { headers });
    assert.deepEqual(await (await get()).json(), { brand: {}, styles: null });

    const put = await strut.app.request("/brand", { method: "PUT", headers: auth, body: JSON.stringify({ color: "#0F766E", radius: "4px" }) });
    assert.equal(put.status, 200);
    const set = (await put.json()) as { brand: unknown; styles: { light: { variables: Record<string, string> } } };
    assert.deepEqual(set.brand, { color: "#0f766e", radius: "4px" });
    assert.equal(set.styles.light.variables["--color-background-inverse"], "#0f766e");
    assert.deepEqual(JSON.parse(await readFile(join(dir, "ws", BRAND_FILE), "utf8")), { color: "#0f766e", radius: "4px" });

    // Another strut reads it; only the key writes it.
    const peerRead = await get({ authorization: `Bearer ${PEER}` });
    assert.equal(peerRead.status, 200);
    assert.deepEqual(((await peerRead.json()) as { brand: unknown }).brand, { color: "#0f766e", radius: "4px" });
    assert.equal((await strut.app.request("/brand", { method: "PUT", headers: { authorization: `Bearer ${PEER}` }, body: "{}" })).status, 403);
    assert.equal((await get({})).status, 401);
    assert.equal((await strut.app.request("/brand", { method: "PUT", body: "{}" })).status, 401);

    // A bad field is refused and changes nothing; a PUT replaces the whole brand.
    const bad = await strut.app.request("/brand", { method: "PUT", headers: auth, body: JSON.stringify({ color: "teal" }) });
    assert.equal(bad.status, 400);
    assert.match(((await bad.json()) as { error: string }).error, /hex color/);
    await strut.app.request("/brand", { method: "PUT", headers: auth, body: JSON.stringify({ font: "Georgia, serif" }) });
    assert.deepEqual(((await (await get()).json()) as { brand: unknown }).brand, { font: "Georgia, serif" });
    await strut.app.request("/brand", { method: "PUT", headers: auth, body: "{}" });
    assert.deepEqual(await (await get()).json(), { brand: {}, styles: null });
    await strut.close();
  });
});
