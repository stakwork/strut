# docker build -t strut .      — or —      docker compose -f docker-compose.yml -f docker-compose.build.yml up --build
#
# Published from main as ghcr.io/stakwork/strut (.github/workflows/publish-image.yml),
# which is what a plain `docker compose up` runs.
#
# The standalone strut server: engine + web UI, plus the tools workflows call
# through the `exec` step and the agent step's bash — ffmpeg, yt-dlp, tesseract,
# poppler, pandoc, ripgrep, git, an agent python venv, and uv for scripts with
# inline (PEP 723) dependencies. Mirrors stakgraph's mcp/Dockerfile (the process
# that embeds strut today) minus the lab-only pieces. Until specs/ENV_SPEC.md
# lands, a native binary a workflow needs goes in the apt line below.
#
# A bare `docker run` defaults to the filesystem workspace backend (no Neo4j);
# docker-compose.yml runs it on the graph backend beside a neo4j container
# (STRUT_WORKSPACE_BACKEND=graph + NEO4J_URI), and with the
# docker-compose.ladybug.yml overlay on a LadybugDB file instead
# (STRUT_WORKSPACE_BACKEND=ladybug: no Neo4j, nothing fetched at boot — the
# two extensions that backend requires are baked in below). Runs, artifacts,
# secrets, and models live under /data — mount volumes there.

# Web UI → web/dist, served by the engine (STRUT_WEB_DIST default). It is
# arch-independent, so it builds once on the build host, not per target. It
# imports src/search.ts, hence the src copy. No web lockfile is committed
# (package-lock.json is gitignored), so `npm install`, not `npm ci`.
FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS web
WORKDIR /usr/src/strut
COPY web/package.json ./web/
RUN npm install --prefix web
COPY src ./src
COPY web ./web
RUN npm run build --prefix web

FROM node:22-bookworm-slim

WORKDIR /usr/src/strut

# System tools. ripgrep + git are what the agent step's built-in tools assume;
# the rest are the media/document CLIs workflows reach through `exec`.
RUN apt-get update && apt-get install -y \
      git ripgrep curl wget jq zip unzip bzip2 \
      python3 python3-pip python3-venv \
      ffmpeg poppler-utils pandoc tesseract-ocr tesseract-ocr-eng \
    && rm -rf /var/lib/apt/lists/* \
    && ln -s /usr/bin/python3 /usr/bin/python

# Agent python venv — the python that agent bash / exec `cmd: python3` see.
# Same contents as mcp's: PDF text (pypdf, pdfplumber; pdftotext from poppler),
# spreadsheets (openpyxl, pandas), numerics (numpy), images (pillow), scraping
# (requests, bs4), media (yt-dlp; ffmpeg from apt), video frame OCR
# (opencv-python-headless + pytesseract over the tesseract binary).
RUN python3 -m venv /usr/src/agent-venv && \
    /usr/src/agent-venv/bin/pip install --no-cache-dir \
      numpy pandas openpyxl pypdf pdfplumber pillow requests beautifulsoup4 yt-dlp \
      opencv-python-headless pytesseract && \
    /usr/src/agent-venv/bin/python -c "import numpy, pandas, openpyxl, pypdf, pdfplumber, PIL, requests, bs4, cv2, pytesseract"
ENV PATH="/usr/src/agent-venv/bin:$PATH"

# uv — `cmd: uv, args: [run]` + a `# /// script` header lets an exec step use a
# library the venv lacks, installed on the fly into ~/.cache/uv (mount it to
# keep those envs across restarts). Pinned; copied from astral's multi-arch
# image so it touches neither python env.
COPY --from=ghcr.io/astral-sh/uv:0.12.1 /uv /uvx /usr/local/bin/

# Fail the build, not a workflow, if a media binary is missing.
RUN ffmpeg -version | head -1 && yt-dlp --version && tesseract --version 2>&1 | head -1 && uv --version

# Engine deps. yarn.lock is the lockfile (package-lock.json is gitignored).
# --ignore-scripts skips the root `prepare`, so the build is explicit below and
# this layer caches until the manifests change. It also skips the dependency
# install scripts in this tree; those of onnxruntime-node (CUDA libs only; the
# CPU binaries ship in the tarball), sharp, esbuild and protobufjs only fetch
# or verify optional binaries, so they are safe to lose. Dev deps stay: tsc
# builds, and tsx is needed at runtime to import the workspace's .ts steps.
# @ladybugdb/core's install script is not safe to lose: it copies the prebuilt
# lbugjs.node from its per-platform package (core-linux-<arch>) into place, and
# without it the memory/* steps fail to load. It is run on its own here, then
# the addon is loaded so a missing binary fails the build, not a workflow.
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --ignore-scripts && yarn cache clean \
    && node node_modules/@ladybugdb/core/install.js \
    && node -e "require('@ladybugdb/core')"

# Ladybug's `vector` + `fts` extensions, which the graph backend REQUIRES to
# open a file (STRUT_WORKSPACE_BACKEND=ladybug; plans/ladybug-backend.md
# ruling 4). With no folder to load them from, the handle `INSTALL`s them at
# boot — a download from extension.ladybugdb.com into ~/.lbdb, which no
# volume keeps: every recreated container fetched them again, and one with
# no egress never booted. So they are fetched HERE, the way the desktop
# packager stages them (scripts/package-desktop.mjs): Ladybug INSTALLs this
# platform's into its cache — they are versioned with the Ladybug CORE, not
# the npm package, so neither a version nor a URL is written down here —
# SHOW_LOADED_EXTENSIONS() says where they landed, and the files are copied
# into native/ (the desktop package's layout), the folder
# STRUT_LADYBUG_EXTENSION_DIR names from here on. The cache is removed: at
# runtime nothing loads from anywhere else. Checked below, once build/ exists.
ENV STRUT_LADYBUG_EXTENSION_DIR=/usr/src/strut/native
RUN node --input-type=module <<'EOF'
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
const lbug = (await import("@ladybugdb/core")).default;
const db = new lbug.Database(":memory:");
const conn = new lbug.Connection(db);
const dir = process.env.STRUT_LADYBUG_EXTENSION_DIR;
const names = ["vector", "fts"];
for (const name of names) {
  await conn.query(`INSTALL ${name}`);
  await conn.query(`LOAD EXTENSION ${name}`);
}
const loaded = await (await conn.query("CALL SHOW_LOADED_EXTENSIONS() RETURN *")).getAll();
mkdirSync(dir, { recursive: true });
for (const name of names) {
  const from = loaded.find((r) => String(r["extension name"]).toLowerCase() === name)?.["extension path"];
  if (!from) throw new Error(`${name} is not among the loaded extensions: ${JSON.stringify(loaded)}`);
  copyFileSync(from, join(dir, `lib${name}.lbug_extension`));
  console.log(`${from} -> ${dir}`);
}
await conn.close();
await db.close();
rmSync(join(homedir(), ".lbdb"), { recursive: true, force: true });
EOF

# Engine build: tsc plus the src/workflows copy (job.yaml, the `job` workflow
# seeded at boot), via package.json's build script.
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# The graph backend's own open, from build/, with the extensions loaded from
# native/ and the download cache gone — the boot's code path on a throwaway
# file, so a missing or wrong extension fails the build, not a container.
RUN node --input-type=module -e 'const { openLadybug } = await import("./build/graph/ladybug/db.js"); const h = await openLadybug("/tmp/ladybug-check/graph.lbug"); console.log("ladybug " + h.version + " opened with the extensions in " + process.env.STRUT_LADYBUG_EXTENSION_DIR); await h.close();' \
    && rm -rf /tmp/ladybug-check

COPY --from=web /usr/src/strut/web/dist ./web/dist

ENV STRUT_WORKSPACE_BACKEND=fs \
    STRUT_WORKSPACE=/data/workspace \
    STRUT_MODEL_DIR=/data/models \
    NODE_ENV=production

EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=6 \
  CMD wget -qO- http://127.0.0.1:3000/health >/dev/null || exit 1

# `--import tsx` registers a TypeScript loader so strut can dynamically import
# the workspace's `.ts` custom steps at runtime (same as mcp's CMD).
CMD ["node", "--import", "tsx", "build/server.js"]
