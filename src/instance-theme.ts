/**
 * The INSTANCE THEME: one brand per strut server. A few tokens a person
 * sets (`PUT /instance/theme`), kept as `<dataDir>/instance-theme.json`,
 * and derived here into the host-context variables the kit's base
 * stylesheet reads (MCP Apps' names where one exists — `--color-background-primary`,
 * `--color-text-primary`, `--font-sans`, … — and strut's own
 * `--color-brand-*` and `--font-heading` where none does; kit/src/styles/base.css).
 * Strut's own host page hands them to every app it frames as
 * `hostContext.styles.variables` (web/src/instance-theme.ts), so an app is
 * branded with no edit and no host passing anything on. A host that reads
 * the brand for its own shell (its sign-in page, its rail) calls the same
 * `GET /instance/theme`, which is open: a brand is not a secret, and the
 * sign-in page wants it before anyone has signed in.
 *
 * The person picks fills and text colours; the button's text is derived —
 * white or near black, whichever contrasts more. Every text/fill pair must
 * reach WCAG AA (4.5:1): the foreground and the muted text on the page and
 * on a surface, the derived text on primary. A theme that does not is
 * refused, so a saved theme is always readable.
 */
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, "a colour is #rrggbb");
/** A `font-family` value: names and generic families, nothing that could
 *  close the declaration or reach out of it. */
const fontStack = z.string().trim().min(1).max(200).regex(/^[^;{}<>\\]+$/, "a font-family stack").refine((s) => !/url\s*\(/i.test(s), "a font-family stack");

/** The colours of one colour scheme. Every one but `primary` is a surface
 *  or text colour, which the kit defaults per scheme; `primary` is the
 *  brand's, the same in both unless `dark` says otherwise. */
const paletteShape = {
  /** Buttons, focus rings, the selected item: shadcn's `primary`. */
  primary: hex,
  /** The page. */
  background: hex.optional(),
  /** Cards, popovers, panels. */
  surface: hex.optional(),
  /** Text. */
  foreground: hex.optional(),
  /** Secondary text. */
  muted: hex.optional(),
  /** Borders and inputs. */
  border: hex.optional(),
};

export const instanceThemeSchema = z
  .object({
    ...paletteShape,
    /** Corner radius: shadcn's `--radius`. Absent: the kit's default. */
    radius: z.enum(["sharp", "default", "round"]).optional(),
    /** Body text: `--font-sans`, the stack as the page's browser has it. */
    fontSans: fontStack.optional(),
    /** Headings (h1–h3): `--font-heading`. Absent: the body's. */
    fontHeading: fontStack.optional(),
    /** The colours under `[data-theme=dark]`. `primary` absent: the light
     *  one; any other absent: the kit's dark neutral, never a light colour. */
    dark: z.object({ ...paletteShape, primary: hex.optional() }).strict().optional(),
  })
  .strict();

export type InstanceTheme = z.infer<typeof instanceThemeSchema>;
type Palette = Omit<InstanceTheme, "radius" | "fontSans" | "fontHeading" | "dark">;
export type ThemeVariables = Record<string, string>;

export const THEME_FILE = "instance-theme.json";
export const MIN_CONTRAST = 4.5;

const RADIUS: Record<NonNullable<InstanceTheme["radius"]>, string> = { sharp: "0.25rem", default: "0.625rem", round: "1rem" };
const WHITE = "#ffffff";
const INK = "#0a0a0a";

/** The kit's neutrals (base.css, shadcn's), as the contrast check reads a
 *  colour the theme leaves to them. Never sent: absent is absent. */
const NEUTRAL: Record<"light" | "dark", Required<Omit<Palette, "primary">>> = {
  light: { background: "#ffffff", surface: "#ffffff", foreground: "#0a0a0a", muted: "#737373", border: "#e5e5e5" },
  dark: { background: "#0f0f0f", surface: "#1c1c1c", foreground: "#fafafa", muted: "#a3a3a3", border: "#2a2a2a" },
};

/** WCAG relative luminance of `#rrggbb`. */
function luminance(color: string): number {
  const channel = (i: number) => {
    const c = parseInt(color.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/** WCAG contrast ratio between two `#rrggbb` colours, 1 to 21. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** The text colour over a fill: white or near black, whichever reads better. */
export function foregroundFor(fill: string): { color: string; ratio: number } {
  const white = contrast(fill, WHITE);
  const ink = contrast(fill, INK);
  return white >= ink ? { color: WHITE, ratio: white } : { color: INK, ratio: ink };
}

/** `a` and `b` mixed in sRGB, `t` of the way to `b`. */
function mix(a: string, b: string, t: number): string {
  const at = (c: string, i: number) => parseInt(c.slice(i, i + 2), 16);
  return "#" + [1, 3, 5].map((i) => Math.round(at(a, i) * (1 - t) + at(b, i) * t).toString(16).padStart(2, "0")).join("");
}

const shown = (ratio: number) => (Math.floor(ratio * 100) / 100).toFixed(2);

export type DerivedTheme = { ok: true; light: ThemeVariables; dark: ThemeVariables } | { ok: false; error: string };

/** The host-context variables a theme becomes, per colour scheme — or why
 *  it cannot: a text/fill pair under AA. */
export function deriveTheme(tokens: InstanceTheme): DerivedTheme {
  const scheme = (mode: "light" | "dark", palette: Palette): { ok: true; vars: ThemeVariables } | { ok: false; error: string } => {
    const at = (name: string) => (mode === "dark" ? `dark.${name}` : name);
    const vars: ThemeVariables = {};
    // The button: its text derived from its fill.
    const fg = foregroundFor(palette.primary);
    if (fg.ratio < MIN_CONTRAST) {
      return { ok: false, error: `${at("primary")} ${palette.primary} reaches ${shown(fg.ratio)}:1 against white and near black; text on it needs ${MIN_CONTRAST}:1 — pick a darker or lighter colour` };
    }
    vars["--color-brand-primary"] = palette.primary.toLowerCase();
    vars["--color-brand-primary-foreground"] = fg.color;
    // Surfaces and text: each pair that reads on the other, the kit's
    // neutral standing in for a colour the theme leaves out.
    const full = { ...NEUTRAL[mode], ...Object.fromEntries(Object.entries(palette).filter(([, v]) => v !== undefined)) } as Required<Omit<Palette, "primary">> & { primary: string };
    for (const text of ["foreground", "muted"] as const) {
      for (const fill of ["background", "surface"] as const) {
        if (palette[text] === undefined && palette[fill] === undefined) continue;
        const ratio = contrast(full[text], full[fill]);
        if (ratio < MIN_CONTRAST) {
          const standIn = palette[text] === undefined ? ` (the kit's default: set ${at(text)} too)` : palette[fill] === undefined ? ` (the kit's default: set ${at(fill)} too)` : "";
          return { ok: false, error: `${at(text)} ${full[text]} on ${at(fill)} ${full[fill]} reaches ${shown(ratio)}:1; text needs ${MIN_CONTRAST}:1${standIn}` };
        }
      }
    }
    if (palette.background) vars["--color-background-primary"] = palette.background.toLowerCase();
    if (palette.surface) vars["--color-brand-surface"] = palette.surface.toLowerCase();
    if (palette.foreground) vars["--color-text-primary"] = palette.foreground.toLowerCase();
    if (palette.muted) vars["--color-text-secondary"] = palette.muted.toLowerCase();
    if (palette.border) vars["--color-border-primary"] = palette.border.toLowerCase();
    // Muted fills (hover, secondary buttons, the sidebar): between the page
    // and its borders, so they stay in the palette's temperature.
    if (palette.background && palette.border) {
      vars["--color-background-secondary"] = mix(full.background, full.border, 0.5);
      vars["--color-background-tertiary"] = full.border.toLowerCase();
    }
    if (tokens.radius) vars["--border-radius-md"] = RADIUS[tokens.radius];
    if (tokens.fontSans) vars["--font-sans"] = tokens.fontSans;
    if (tokens.fontHeading) vars["--font-heading"] = tokens.fontHeading;
    return { ok: true, vars };
  };
  const { radius: _r, fontSans: _s, fontHeading: _h, dark: darkTokens, ...lightPalette } = tokens;
  const light = scheme("light", lightPalette);
  if (!light.ok) return light;
  const dark = scheme("dark", { ...darkTokens, primary: darkTokens?.primary ?? tokens.primary });
  if (!dark.ok) return dark;
  return { ok: true, light: light.vars, dark: dark.vars };
}

export interface StoredTheme {
  version: number;
  tokens: InstanceTheme;
  updatedAt: string;
}

/** What `GET /instance/theme` serves: the tokens and what they derive to.
 *  With none set, version 0 and empty variables — the kit's neutral defaults. */
export interface InstanceThemeResponse {
  version: number;
  tokens: InstanceTheme | null;
  variables: { light: ThemeVariables; dark: ThemeVariables };
}

export function themeResponse(stored: StoredTheme | undefined): { body: InstanceThemeResponse; etag: string } {
  if (!stored) return { body: { version: 0, tokens: null, variables: { light: {}, dark: {} } }, etag: '"0"' };
  const derived = deriveTheme(stored.tokens);
  // A file edited by hand into something unreadable serves the defaults
  // rather than failing every page.
  const variables = derived.ok ? { light: derived.light, dark: derived.dark } : { light: {}, dark: {} };
  return { body: { version: stored.version, tokens: stored.tokens, variables }, etag: `"${stored.version}.${Date.parse(stored.updatedAt) || 0}"` };
}

export interface InstanceThemeStore {
  get(): Promise<StoredTheme | undefined>;
  set(tokens: InstanceTheme): Promise<StoredTheme>;
  clear(): Promise<void>;
}

/** `<dataDir>/instance-theme.json`, written whole and atomically. */
export function instanceThemeStore(dataDir: string): InstanceThemeStore {
  const file = join(dataDir, THEME_FILE);
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn, fn);
    chain = next.catch(() => {});
    return next;
  };
  const get = async (): Promise<StoredTheme | undefined> => {
    try {
      const raw = JSON.parse(await readFile(file, "utf-8")) as Partial<StoredTheme>;
      const tokens = instanceThemeSchema.safeParse(raw.tokens);
      if (!tokens.success) return undefined;
      return { version: typeof raw.version === "number" ? raw.version : 1, tokens: tokens.data, updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date(0).toISOString() };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
  };
  return {
    get,
    set: (tokens) =>
      serial(async () => {
        const previous = await get();
        const stored: StoredTheme = { version: (previous?.version ?? 0) + 1, tokens, updatedAt: new Date().toISOString() };
        await mkdir(dataDir, { recursive: true });
        await writeFile(`${file}.tmp`, JSON.stringify(stored, null, 2));
        await rename(`${file}.tmp`, file);
        return stored;
      }),
    clear: () => serial(() => rm(file, { force: true })),
  };
}
