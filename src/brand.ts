import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

// ── The BRAND (specs/API.md §14.12) ─────────────────────────────────────────
//
// What every app on this server looks like, set by a person, never built
// into one: a color, a corner radius, a font. An app's page takes its
// look from its HOST — the kit's stylesheet reads the MCP Apps style
// variables (`--color-background-inverse`, `--border-radius-md`,
// `--font-sans`, …) before its own defaults (kit/src/styles/base.css) — so
// strut's host sends the brand as those variables (web/src/app-host.ts)
// and every app, published or not, picks it up the next time it loads.
//
// Only STANDARD variable names: the MCP Apps client checks the host's
// variables against the spec's list, and another host's page reads the
// same names. One record, `<dataDir>/brand.json`, written by a person
// (`PUT /brand`, full scope); every credential reads it (`GET /brand`).

export const BRAND_FILE = "brand.json";

export interface Brand {
  /** The brand's color, `#rrggbb`: primary buttons, the selected item,
   *  focus rings. Its text color is picked for contrast. */
  color?: string;
  /** The color in the dark theme; `color` when unset. */
  colorDark?: string;
  /** Corner radius, a CSS length (`0.5rem`, `6px`). */
  radius?: string;
  /** A font-family list (`"Avenir Next", system-ui, sans-serif`). Only
   *  fonts the viewer's machine has render: an app's page loads no font
   *  from the network. */
  font?: string;
}

/** The variables a page is handed for one theme, standard names only. */
export interface BrandStyles {
  variables: Record<string, string>;
}

const FIELDS = ["color", "colorDark", "radius", "font"] as const;
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const LENGTH = /^(?:0|\d{1,3}(?:\.\d{1,3})?(?:px|rem|em))$/;
/** Names, quotes, commas and spaces: nothing that could end the value. */
const FONT = /^[\p{L}\p{N} "',._-]{1,200}$/u;

/** Why `body` is not a brand, or undefined. An empty string or null clears
 *  a field. */
export function brandProblem(body: unknown): string | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "the brand is { color?, colorDark?, radius?, font? }";
  for (const [k, v] of Object.entries(body)) {
    if (!(FIELDS as readonly string[]).includes(k)) return `unknown field "${k}" (the brand is { color?, colorDark?, radius?, font? })`;
    if (v === null || v === "") continue;
    if (typeof v !== "string") return `${k} is a string`;
    if ((k === "color" || k === "colorDark") && !HEX.test(v)) return `${k} is a hex color, #rrggbb`;
    if (k === "radius" && !LENGTH.test(v)) return "radius is a length in px, rem or em (0.5rem, 6px)";
    if (k === "font" && !FONT.test(v)) return "font is a font-family list (\"Avenir Next\", system-ui, sans-serif)";
  }
  return undefined;
}

/** The brand as kept: empty fields dropped, a color as lowercase `#rrggbb`. */
export function normalizeBrand(body: Record<string, unknown>): Brand {
  const out: Brand = {};
  for (const k of FIELDS) {
    const v = body[k];
    if (typeof v !== "string" || !v.trim()) continue;
    out[k] = k === "color" || k === "colorDark" ? longHex(v) : v.trim();
  }
  return out;
}

/** The variables for each theme, or null when the brand sets nothing. */
export function brandStyles(brand: Brand): { light: BrandStyles; dark: BrandStyles } | null {
  if (!FIELDS.some((k) => brand[k])) return null;
  const forTheme = (color: string | undefined): BrandStyles => {
    const v: Record<string, string> = {};
    if (color) {
      v["--color-background-inverse"] = color;
      v["--color-text-inverse"] = textOn(color);
      v["--color-ring-primary"] = color;
    }
    if (brand.radius) v["--border-radius-md"] = brand.radius;
    if (brand.font) v["--font-sans"] = brand.font;
    return { variables: v };
  };
  return { light: forTheme(brand.color ?? brand.colorDark), dark: forTheme(brand.colorDark ?? brand.color) };
}

/** Near-black or white, whichever reads better on `hex` (WCAG contrast). */
export function textOn(hex: string): string {
  const l = luminance(hex);
  const dark = 0.0032; // #0a0a0a, the kit's foreground
  return (l + 0.05) / (dark + 0.05) >= 1.05 / (l + 0.05) ? "#0a0a0a" : "#ffffff";
}

function luminance(hex: string): number {
  const h = longHex(hex).slice(1);
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(h.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function longHex(hex: string): string {
  const h = hex.trim().toLowerCase();
  return h.length === 4 ? `#${h[1]}${h[1]}${h[2]}${h[2]}${h[3]}${h[3]}` : h;
}

export async function readBrand(dataDir: string): Promise<Brand> {
  let raw: string;
  try {
    raw = await readFile(join(dataDir, BRAND_FILE), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
  const parsed: unknown = JSON.parse(raw);
  const problem = brandProblem(parsed);
  if (problem) throw new Error(`${BRAND_FILE}: ${problem}`);
  return normalizeBrand(parsed as Record<string, unknown>);
}

/** Writes the brand; one that sets nothing removes the file. */
export async function writeBrand(dataDir: string, brand: Brand): Promise<void> {
  const file = join(dataDir, BRAND_FILE);
  if (!FIELDS.some((k) => brand[k])) {
    await rm(file, { force: true });
    return;
  }
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tmp, `${JSON.stringify(brand, null, 2)}\n`, "utf8");
  await rename(tmp, file);
}
