import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { compileStyles, readBaseStylesheet, scanCandidates } from "./node.js";

describe("the base stylesheet", () => {
  it("compiles, maps the host's variables onto shadcn's tokens with fallbacks, and styles both dark conventions", async () => {
    const css = await compileStyles({
      candidates: ["bg-background", "text-foreground", "rounded-lg", "font-sans", "dark:bg-card", "shadow-md", "text-sm", "border-border", "text-destructive"],
      kitCandidates: [],
    });
    assert.match(css, /--background:\s*var\(--color-background-primary,\s*oklch\(1 0 0\)\)/);
    assert.match(css, /--destructive:\s*var\(--color-text-danger,/);
    assert.match(css, /--radius:\s*var\(--border-radius-md,\s*0\.625rem\)/);
    assert.match(css, /\.text-sm\s*\{[^}]*font-size:\s*var\(--font-text-sm-size,\s*0?\.875rem\)/);
    assert.match(css, /\.bg-background\s*\{[^}]*background-color:\s*var\(--background\)/);
    assert.match(css, /\.dark\\:bg-card/);
    assert.match(css, /\[data-theme="dark"\]/);
    assert.match(css, /\.font-sans\s*\{[^}]*font-family:\s*var\(--font-sans\)/);
    assert.match(css, /\.shadow-md\s*\{/);
    // The host's own names stay untouched, so an inline `--font-sans` or `--shadow-md` on <html> wins.
    assert.doesNotMatch(readBaseStylesheet(), /--font-sans:\s*var\(--font-sans/);
  });

  it("scanCandidates keeps the classes and drops the code", async () => {
    const got = await scanCandidates(['<div className={cn("inline-flex bg-primary/90 data-[state=open]:bg-accent", props.x)} />', "const useState = 1"]);
    assert.deepEqual(got, ["bg-primary/90", "data-[state=open]:bg-accent", "inline-flex"]);
  });
});
