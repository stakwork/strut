import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contrast, deriveTheme, foregroundFor, instanceThemeSchema, instanceThemeStore, themeResponse, THEME_FILE } from "./instance-theme.js";

/** A host's real palette (stadeum): warm paper and ink, a serif for headings. */
const STADEUM = {
  primary: "#23436b",
  background: "#f6f4ee",
  surface: "#ffffff",
  foreground: "#1b1a17",
  muted: "#5f5b52",
  border: "#e4e0d6",
  fontSans: "Inter, system-ui, sans-serif",
  fontHeading: "Newsreader, Georgia, serif",
  dark: { primary: "#9db7d9", background: "#161513", surface: "#1f1e1b", foreground: "#eeebe4", muted: "#a19b8f", border: "#34322d" },
};

describe("the instance theme", () => {
  it("derives each foreground as white or near black, whichever reads better", () => {
    assert.equal(foregroundFor("#6d28d9").color, "#ffffff", "purple takes white");
    assert.equal(foregroundFor("#fde68a").color, "#0a0a0a", "pale yellow takes ink");
    assert.ok(contrast("#ffffff", "#000000") > 20.9);
    assert.equal(contrast("#777777", "#777777"), 1);
  });

  it("primary alone: the brand variables per scheme, dark overriding the fill", () => {
    const derived = deriveTheme({ primary: "#6D28D9", radius: "round", dark: { primary: "#c4b5fd" } });
    assert.ok(derived.ok);
    assert.deepEqual(derived.light, { "--color-brand-primary": "#6d28d9", "--color-brand-primary-foreground": "#ffffff", "--border-radius-md": "1rem" });
    assert.deepEqual(derived.dark, { "--color-brand-primary": "#c4b5fd", "--color-brand-primary-foreground": "#0a0a0a", "--border-radius-md": "1rem" });
    const plain = deriveTheme({ primary: "#1e40af" });
    assert.ok(plain.ok);
    assert.deepEqual(plain.dark, plain.light, "no dark override: the light fill again");
    assert.equal("--border-radius-md" in plain.light, false, "no radius: the kit's default stands");
  });

  it("a whole palette: surfaces, text and borders onto MCP Apps' names, muted fills mixed from them, fonts as given", () => {
    const derived = deriveTheme(STADEUM);
    assert.ok(derived.ok, (derived as { error?: string }).error);
    assert.deepEqual(derived.light, {
      "--color-brand-primary": "#23436b",
      "--color-brand-primary-foreground": "#ffffff",
      "--color-background-primary": "#f6f4ee",
      "--color-brand-surface": "#ffffff",
      "--color-text-primary": "#1b1a17",
      "--color-text-secondary": "#5f5b52",
      "--color-border-primary": "#e4e0d6",
      "--color-background-secondary": "#edeae2",
      "--color-background-tertiary": "#e4e0d6",
      "--font-sans": "Inter, system-ui, sans-serif",
      "--font-heading": "Newsreader, Georgia, serif",
    });
    assert.equal(derived.dark["--color-brand-primary"], "#9db7d9");
    assert.equal(derived.dark["--color-brand-primary-foreground"], "#0a0a0a", "a pale blue takes ink");
    assert.equal(derived.dark["--color-background-primary"], "#161513");
    assert.equal(derived.dark["--color-background-secondary"], "#252420");
    assert.equal(derived.dark["--font-heading"], "Newsreader, Georgia, serif", "fonts are not per scheme");
  });

  it("in dark, a surface or text colour left out is the kit's dark neutral, never the light one", () => {
    const derived = deriveTheme({ primary: "#23436b", background: "#f6f4ee", foreground: "#1b1a17", muted: "#5f5b52", dark: { foreground: "#eeebe4" } });
    assert.ok(derived.ok, (derived as { error?: string }).error);
    assert.equal(derived.dark["--color-text-primary"], "#eeebe4");
    assert.equal("--color-background-primary" in derived.dark, false, "no dark background: the kit's");
    assert.equal("--color-background-secondary" in derived.light, false, "no border: no muted fill derived");
  });

  it("refuses a text/fill pair under AA, naming it — the kit's neutral standing in for a colour left out", () => {
    const mid = deriveTheme({ primary: "#1e40af", dark: { primary: "#777777" } });
    assert.equal(mid.ok, false);
    assert.match((mid as { error: string }).error, /^dark\.primary #777777 reaches 4\.4\d:1/);
    const faint = deriveTheme({ primary: "#1e40af", muted: "#b0b0b0" });
    assert.equal(faint.ok, false);
    assert.match((faint as { error: string }).error, /^muted #b0b0b0 on background #ffffff reaches 2\.\d\d:1; text needs 4\.5:1 \(the kit's default: set background too\)$/);
    // Warm paper under the kit's own grey: the default muted text no longer reads, so the page says to set it.
    const paper = deriveTheme({ primary: "#1e40af", background: "#f6f4ee" });
    assert.equal(paper.ok, false);
    assert.match((paper as { error: string }).error, /^muted #737373 on background #f6f4ee reaches 4\.3\d:1; .*set muted too\)$/);
    const onSurface = deriveTheme({ primary: "#1e40af", background: "#000000", foreground: "#ffffff", surface: "#dddddd" });
    assert.equal(onSurface.ok, false);
    assert.match((onSurface as { error: string }).error, /^foreground #ffffff on surface #dddddd/);
    const darkOnly = deriveTheme({ primary: "#1e40af", dark: { foreground: "#333333" } });
    assert.equal(darkOnly.ok, false);
    assert.match((darkOnly as { error: string }).error, /^dark\.foreground #333333 on dark\.background #0f0f0f/);
  });

  it("takes #rrggbb, the three radii and font stacks, nothing else", () => {
    assert.ok(instanceThemeSchema.safeParse({ primary: "#6d28d9" }).success);
    assert.ok(instanceThemeSchema.safeParse(STADEUM).success);
    for (const bad of [
      {},
      { primary: "purple" },
      { primary: "#6d28d9", radius: "huge" },
      { primary: "#6d28d9", accent: "#ffffff" },
      { primary: "#fff" },
      { primary: "#6d28d9", background: "white" },
      { primary: "#6d28d9", dark: { logo: "x.png" } },
      { primary: "#6d28d9", fontSans: "" },
      { primary: "#6d28d9", fontSans: "Inter; color: red" },
      { primary: "#6d28d9", fontHeading: "url(https://x.test/f.woff2)" },
      { primary: "#6d28d9", fontHeading: "x".repeat(201) },
    ]) {
      assert.equal(instanceThemeSchema.safeParse(bad).success, false, JSON.stringify(bad));
    }
  });

  describe("the store", () => {
    let dir: string;
    beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "strut-theme-")); });
    afterEach(() => rm(dir, { recursive: true, force: true }));

    it("keeps one file under dataDir, versions each save, and clears back to nothing", async () => {
      const store = instanceThemeStore(join(dir, "data"));
      assert.equal(await store.get(), undefined);
      assert.deepEqual(themeResponse(undefined), { body: { version: 0, tokens: null, variables: { light: {}, dark: {} } }, etag: '"0"' });

      const first = await store.set({ primary: "#6d28d9" });
      assert.equal(first.version, 1);
      const second = await store.set({ primary: "#1e40af", radius: "sharp" });
      assert.equal(second.version, 2);
      const onDisk = JSON.parse(await readFile(join(dir, "data", THEME_FILE), "utf-8")) as { tokens: unknown };
      assert.deepEqual(onDisk.tokens, { primary: "#1e40af", radius: "sharp" });

      const { body, etag } = themeResponse(await store.get());
      assert.equal(body.version, 2);
      assert.equal(body.variables.light["--color-brand-primary"], "#1e40af");
      assert.match(etag, /^"2\.\d+"$/);

      await store.clear();
      assert.equal(await store.get(), undefined);
      await store.clear();
    });

    it("a file that is not a theme serves the defaults", async () => {
      const { writeFile, mkdir } = await import("node:fs/promises");
      await mkdir(join(dir, "data"), { recursive: true });
      await writeFile(join(dir, "data", THEME_FILE), JSON.stringify({ version: 3, tokens: { primary: "mauve" } }));
      assert.equal(await instanceThemeStore(join(dir, "data")).get(), undefined);
    });
  });
});
