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
# (STRUT_WORKSPACE_BACKEND=graph + NEO4J_URI). Runs, artifacts, secrets, and
# models live under /data — mount volumes there.

# One Node for every stage. Pinned to the patch so a security release is a
# visible bump here, not whatever the floating tag held when the cache was made.
ARG NODE_VERSION=22.23.4

# Web UI → web/dist, served by the engine (STRUT_WEB_DIST default). It is
# arch-independent, so it builds once on the build host, not per target. It
# imports src/search.ts, hence the src copy, and the kit's folds from source
# (`@strut/kit/folds`, aliased in web/vite.config.ts), hence that copy. No web
# lockfile is committed (package-lock.json is gitignored), so `npm install`,
# not `npm ci`.
FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-bookworm-slim AS web
WORKDIR /usr/src/strut
COPY web/package.json ./web/
RUN npm install --prefix web
COPY src ./src
COPY kit/src/folds ./kit/src/folds
COPY web ./web
RUN npm run build --prefix web

# The app kit's vendor layer → kit/vendor (plans/apps.md §3; what every app
# build resolves against, src/apps/kit.ts): a frozen module tree, arch-independent,
# built once on the build host like web/. Only kit/vendor reaches the image —
# the kit's own node_modules (React and the rest of the set) stays here.
FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-bookworm-slim AS kit
WORKDIR /usr/src/strut
COPY kit/package.json kit/yarn.lock ./kit/
RUN yarn --cwd kit install --frozen-lockfile --ignore-scripts --production=false && yarn cache clean
COPY kit ./kit
RUN yarn --cwd kit build:vendor

FROM node:${NODE_VERSION}-bookworm-slim

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
# (opencv-python-headless + pytesseract over the tesseract binary). certifi is
# requests' CA bundle, pinned past the compromised emSign intermediates
# (GHSA-6q48-6c7w-9gw2).
RUN python3 -m venv /usr/src/agent-venv && \
    /usr/src/agent-venv/bin/pip install --no-cache-dir \
      numpy pandas openpyxl pypdf pdfplumber pillow requests "certifi>=2026.10.19" \
      beautifulsoup4 yt-dlp opencv-python-headless pytesseract && \
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

# Engine build: tsc plus the src/workflows copy (job.yaml, the `job` workflow
# seeded at boot), via package.json's build:engine script (`build` would also
# build the kit, which the `kit` stage did).
COPY tsconfig.json ./
COPY src ./src
RUN npm run build:engine

# Ladybug's vector + fts extensions, which the graph backend needs to open:
# the pinned bytes for the installed core on the target arch (extensions.ts,
# sha256-verified), in native/ as the desktop package carries them, so the
# image never downloads them at start and needs no ~/.lbdb or model-cache
# volume for them. The check opens a graph with no network: a load that
# would reach for the extension host fails the build, amd64 and arm64 alike.
COPY scripts/image-ladybug-extensions.mjs ./scripts/
RUN node scripts/image-ladybug-extensions.mjs stage /usr/src/strut/native
ENV STRUT_LADYBUG_EXTENSION_DIR=/usr/src/strut/native
RUN --network=none node scripts/image-ladybug-extensions.mjs check

COPY --from=web /usr/src/strut/web/dist ./web/dist

# The kit as the app build reads it: the vendor layer + the base stylesheet,
# at <strut>/kit where src/apps/kit.ts looks. Then the fixture app is built
# with the compiled engine, the image's esbuild and tailwindcss — an image in
# which `app/build` cannot produce a document fails here.
COPY --from=kit /usr/src/strut/kit/vendor ./kit/vendor
COPY kit/src/styles/base.css ./kit/src/styles/base.css
COPY scripts/check-app-build.mjs ./scripts/
RUN node scripts/check-app-build.mjs

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
