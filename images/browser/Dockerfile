# docker build -t strut-browser images/browser
# docker run --rm -p 3300:3000 -e BROWSER_WS_PATH=<any hex string> strut-browser
#
# A Playwright SERVER: the browser a strut host drives over a websocket
# (`chromium.connect("ws://<host>:3000/<BROWSER_WS_PATH>")`). Each connection
# gets its own headless Chromium, launched by the server; the host opens a
# BrowserContext per run inside it. Published as ghcr.io/stakwork/strut-browser
# by .github/workflows/publish-browser.yml.
#
# The stock image ships node and the browsers but not the `playwright`
# package; it is baked in here, so a container start fetches nothing.
#
# PLAYWRIGHT_VERSION is the image's version and its tag. The CLIENT
# (`playwright-core` in the host that connects) must be on the same
# major.minor: the server refuses any other. Bump them together.

ARG PLAYWRIGHT_VERSION=1.64.1
FROM mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-noble
ARG PLAYWRIGHT_VERSION

LABEL org.opencontainers.image.source="https://github.com/stakwork/strut"
LABEL org.opencontainers.image.description="Playwright server for strut browser steps"

# tini reaps the Chromium processes a closed context leaves behind, so the
# image needs no `--init` from whoever runs it. The browsers are already in
# the base image (/ms-playwright), at this version.
RUN apt-get update && apt-get install -y --no-install-recommends tini \
    && rm -rf /var/lib/apt/lists/* \
    && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install -g playwright@${PLAYWRIGHT_VERSION} \
    && npm cache clean --force

# CHROME_VERSION pins the Chromium actually run. Playwright 1.64.1 bundles
# 156.0.8078.4, older than the CVE-2026-118306 fix (FileSystem use-after-free,
# fixed in 156.0.8078.73), so the bundled browsers are replaced with the same
# Chrome for Testing builds Playwright itself uses on Linux, same layout.
# MUST be bumped whenever a Chrome CVE fix lands (and PLAYWRIGHT_VERSION when
# Playwright catches up, at which point this layer can go). The version is in
# the RUN text, so changing the pin changes the layer key; the build fails if
# the binary does not report this version. Chrome for Testing has no linux
# arm64 build, so on arm64 the bundled Chromium is kept: it is older than the
# CVE fix, so arm64 images are NOT CVE-patched.
ARG CHROME_VERSION=156.0.8078.73
RUN set -eux; \
    echo "chrome pin: ${CHROME_VERSION}"; \
    apt-get update && apt-get install -y --no-install-recommends unzip ca-certificates curl; \
    rm -rf /var/lib/apt/lists/*; \
    case "$(uname -m)" in x86_64) cft=linux64;; *) echo "Chrome for Testing has no linux build for $(uname -m)"; cft=;; esac; \
    if [ -n "$cft" ]; then \
      base=https://storage.googleapis.com/chrome-for-testing-public/${CHROME_VERSION}/${cft}; \
      cd /tmp; \
      curl -fsSL -o chrome.zip "$base/chrome-linux64.zip"; \
      curl -fsSL -o shell.zip "$base/chrome-headless-shell-linux64.zip"; \
      unzip -q chrome.zip; unzip -q shell.zip; \
      full=$(ls -d /ms-playwright/chromium-*/chrome-linux64 | head -1); \
      shell=$(ls -d /ms-playwright/chromium_headless_shell-*/chrome-headless-shell-linux64 | head -1); \
      find "$full" -mindepth 1 -delete; cp -a chrome-linux64/. "$full"/; \
      find "$shell" -mindepth 1 -delete; cp -a chrome-headless-shell-linux64/. "$shell"/; \
      touch "$(dirname "$full")/INSTALLATION_COMPLETE" "$(dirname "$shell")/INSTALLATION_COMPLETE"; \
      rm -rf /tmp/chrome* /tmp/shell.zip; \
      "$full/chrome" --version | tee /dev/stderr | grep -F "${CHROME_VERSION}"; \
      "$shell/chrome-headless-shell" --version | tee /dev/stderr | grep -F "${CHROME_VERSION}"; \
    else echo "keeping bundled Chromium for $(uname -m)"; fi

# Playwright launches Chromium without its sandbox, so not as root.
USER pwuser
WORKDIR /home/pwuser

ENV PORT=3000
EXPOSE 3000

# BROWSER_WS_PATH is the secret endpoint, the browser's only door: an upgrade
# on any other path is refused, and the container will not start without it.
# --host 0.0.0.0: the default binds the loopback only.
ENTRYPOINT ["tini", "--"]
CMD ["sh", "-c", "exec playwright run-server --host 0.0.0.0 --port \"$PORT\" --path \"/${BROWSER_WS_PATH:?set BROWSER_WS_PATH}\""]
