# A served app

One strut serving one package's app at a domain (plans/app-repos.md §4).
The package is the app's whole source: workflows and steps for the back end,
`apps/<name>/` for the front end, and a `serve.yaml` saying which app `/`
shows and what a visitor may run. The box installs it, follows it, and
answers `/` with the app alone. Nothing of strut's UI is drawn for a
visitor.

## 1. The package

A package with a `serve.yaml` at its top (src/packages/serve.ts):

```yaml
app: game                       # apps/game is what / shows
title: Moon Lander              # <title>, og:title (default: the app's title)
description: Land softly.       # og:description (default: the app's)
image: apps/game/public/og.png  # og:image, an image file in the package
reads: [score-board]            # steps the visitor's page may call
runnable:                       # what anyone may run, and for how much
  - { kind: workflow, name: ghost, dailyCapUsd: 5 }
concepts: [Moon Lander]         # Concept roots in the public view
```

Names are the package's own (`ghost`, not `acme/moonlander/ghost`). The
file is checked as a person's `PUT /public-view` is, and is the box's whole
public view.

To publish one from a strut, name the fields as `serve` on the publish, and
make its channel public:

```bash
curl -fsS -X POST "$PUBLISHER/packages/publish" -H "authorization: Bearer $KEY" \
  -H 'content-type: application/json' -d '{
    "package": "acme/moonlander", "version": "1.0.0",
    "apps": ["game"], "workflows": ["ghost"],
    "channel": "stable", "public": true,
    "serve": { "app": "game", "title": "Moon Lander", "runnable": [{ "kind": "workflow", "name": "ghost", "dailyCapUsd": 5 }] }
  }'
curl -fsS "$PUBLISHER/publisher" -H "authorization: Bearer $KEY"   # its `public` key
```

The ref is then `pk:<public key>/acme/moonlander`, its catalog
`$PUBLISHER/packages/catalog?public=1`.

## 2. The box

Point the domain's A record at the box, then:

```bash
curl -fsSL https://get.docker.com | sudo sh
scp -r deploy/app <box>:app        # from a strut checkout
cd app && cp env.example .env      # fill it in
sudo docker compose up -d
```

`https://<domain>/` is the app. The first deploy runs in the background
once strut is up; until it lands, `/` says nothing is served yet.

## 3. Operating it

```bash
curl -fsS "https://$STRUT_APP_HOST/serve" -H "authorization: Bearer $STRUT_API_KEY"
```

`GET /serve` names the ref, what is serving (package, version, digest, the
app and the version visitors open), the last read of the ref, and the last
error. A deploy that cannot resolve, install or apply leaves the previous
one serving and says why there. `sudo docker compose logs strut | grep
'\[serve\]'` has one line per deploy.

`https://<domain>/?shell=1&key=<STRUT_API_KEY>` opens strut's own UI: runs,
logs, secrets. A visitor never sees it.

A new release is deployed at the next poll (`STRUT_DISTRO_POLL_MINUTES`,
10 by default). For it to land at once, set `STRUT_PEER_KEY` here and put
this box on file as a peer on the publisher's strut with that key
(`PUT /peers/:id`): a publish pings every peer.

`PUT /public-view` is refused on a served box: change `serve.yaml` in the
package and publish a release.
