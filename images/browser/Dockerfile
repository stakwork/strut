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

ARG PLAYWRIGHT_VERSION=1.63.0
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
