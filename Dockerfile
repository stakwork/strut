# docker build -t strut .      — or —      docker compose up --build
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
# this layer caches until the manifests change. It also skips the two dependency
# install scripts in this tree, both safe to lose: onnxruntime-node's only
# fetches CUDA libs (the linux x64/arm64 CPU binaries the graph backend's MiniLM
# embedder loads ship in the tarball), and sharp's only checks for its prebuilt
# @img/* binary. Dev deps stay: tsc builds, and tsx is needed at
# runtime to import the workspace's .ts custom steps.
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --ignore-scripts && yarn cache clean

# Web UI deps (npm; web/package-lock.json).
COPY web/package.json web/package-lock.json ./web/
RUN npm ci --prefix web

# Engine build.
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc

# Web UI build → web/dist, served by the engine (STRUT_WEB_DIST default).
COPY web ./web
RUN npm run build --prefix web

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
