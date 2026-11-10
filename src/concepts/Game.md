---
description: A GAME — an app whose view is a canvas, 2D or 3D; the game starter, the loop, input on keys and touch, sound, models and other assets, physics, scores, multiplayer, and how to look at one you are building.
parent: App
---
A GAME is an app (the `App` page: layout, kit, grants, build, look,
publish) whose view is a canvas instead of a page of components. Everything
on the App page holds; this page is what is different.

## Start from the starter

`app/init { path: "apps/<name>", template: "game" }` scaffolds a small
3D game that works: a ball rolls after coins against the clock, with
physics, keys and touch, sound with no files, a HUD and menus over the
canvas, the player's best score kept, and `window.__debug` set. Change it
into the game the person asked for: the scene in `src/game/World.tsx`, the
state in `src/game/store.ts`, input in `src/game/input.ts`, sound in
`src/game/sound.ts`, the HUD and menus in `src/App.tsx`. Delete what the
game does not need before adding to it.

A 2D game needs no library: a `<canvas>`, its 2D context and one
`requestAnimationFrame` loop in an effect.

## What the kit has for games

- `three` and `@react-three/fiber` (R3F): the scene as components,
  `useFrame` for per-frame work.
- `@react-three/drei`: R3F helpers — `Sky`, `Stars`, `Float`, `Html`,
  `OrbitControls`, `useGLTF`, `useTexture`, `ContactShadows`, and more.
- Physics, Rapier: `@react-three/rapier` inside R3F (`<Physics>`,
  `<RigidBody>`, colliders, sensors), or the engine itself —
  `@dimforge/rapier3d-compat`, `@dimforge/rapier2d-compat` (call
  `await RAPIER.init()` once before making a world).
- three's addons by path, as three's docs write them:
  `import { OrbitControls } from "three/addons/controls/OrbitControls.js"`
  (`three/examples/jsm/…` is the same file): loaders, controls,
  post-processing, geometries, utilities.
- `@react-three/postprocessing` (`<EffectComposer><Bloom/></EffectComposer>`),
  `three-mesh-bvh` (fast raycasts against big meshes: terrain, walls).
- `zustand` for game state, `motion` for menus, the shadcn components for
  the HUD.

## The loop

What changes every frame never goes through React state: a position, a
velocity, a timer's fraction. Keep it in refs or a plain module object and
change it in `useFrame` (R3F) or the 2D loop. React state is only what the
HUD shows — score, lives, the phase — read with a zustand selector, so a
component re-renders when its field changes and not sixty times a second.
Move by `dt` (the frame's seconds), never by frames.

The frame is the game's page: give `html, body, #root` `height: 100%` and
the game's container `h-dvh min-h-[480px]`. A host that sizes its frame to
the content then gets 480 pixels, never zero.

## Input

- **Keys** reach the page only while its frame has focus, and a click or a
  tap gives it focus: start a round from a button. Listen on `window`
  (`keydown`, `keyup`), by `e.code` (`KeyW`, `ArrowLeft`, `Space`); keep the
  held keys in a set the loop reads; `preventDefault` arrows and Space;
  clear the set on `blur`.
- **Touch**: every mechanic needs a touch answer — people open apps on
  phones. Put `touch-action: none` on the game's container; a drag is an
  invisible joystick, a tap the action. Say the controls for both on the
  start screen.
- **Gamepad, mouse-look (pointer lock), fullscreen** work in every app's
  frame: `navigator.getGamepads()`, `canvas.requestPointerLock()` and
  `element.requestFullscreen()` from a click. **Tilt** needs the manifest's
  `permissions:` (below).

## Sound

Web Audio, started by the first click or key (a browser waits for one).
Short notes from oscillators need no files (the starter's `sound.ts`). A
recorded sound is a file in the app: `import hit from "../public/hit.mp3"`
is a data URL — `new Audio(hit).play()`, or `fetch(hit)` →
`arrayBuffer()` → `decodeAudioData` for Web Audio. Always a mute button.

## Models, textures and other files

A file in the app's folder (`public/` by convention) is imported by path,
and the import is a data URL inlined into the document:

```ts
import ship from "../public/ship.glb";
const { scene } = useGLTF(ship);            // drei
new GLTFLoader().load(ship, (gltf) => …);  // three's loader, the same
const bytes = await (await fetch(ship)).arrayBuffer();
```

Models (`.glb`, `.obj`, `.fbx`, `.stl`, `.ply`, `.vox`), textures and maps
(`.png`, `.jpg`, `.webp`, `.hdr`, `.exr`, `.ktx2`), sounds (`.mp3`, `.ogg`,
`.wav`, `.m4a`), fonts and `.bin` all import this way. Use `.glb` — one
file — not a `.gltf` with buffers beside it.

The page can `fetch` only a data: URL (an imported file) or a blob: URL it
made. Nothing is served beside the document, so `"/models/ship.glb"`
fails, and so does anything on the internet. That rules out drei pieces
that download: `<Environment preset="…">` (pass `files={hdr}`, an imported
`.hdr`), `<Text>` with no `font` (import a `.ttf` or `.woff` and pass it),
and Draco- or Meshopt-compressed models (their decoders are downloaded;
export the model uncompressed).

Everything imported is in the one document: under 20 MB of files, and a
document over 6 MB is slow to open. Keep models low-poly and textures
small; a few MB in all.

A file the game did not ship with comes in at run time. One a run made
(a level or a model a workflow generated; grant the workflow) is a URL
from `useRunFileUrl(workflow, runId, path)` — `const { url } =
useRunFileUrl("make-level", runId, "level.glb")`, then `useGLTF(url)` or
`fetch(url)` — up to about 3.7 MB. One the player picks with
`<input type="file">` is `URL.createObjectURL(file)` (keep it with
`useUpload` when it must outlast the visit).

## Physics

Rapier compiles WebAssembly, which an app's page allows. Put `<Physics>`
inside `<Suspense>` (it loads the engine first). For control that feels
like a game, set the player's velocity toward where the input points
(`setLinvel`) rather than pushing it with forces. A pickup is a sensor
collider (`sensor`, `onIntersectionEnter`): the player passes through, the
sensor reports it. Name the player's body (`name="player"`) to tell it
from the rest.

## Scores, saves and other players

- **One player's** best score, settings and save: `useAppState("best", 0)`.
  It is kept by the strut server for that viewer on every device;
  `localStorage` lasts only the visit.
- **Everyone's** — a leaderboard: declare a type in `data.graph`
  (`Score: { player: string, points: number, at: date, key: [player, at] }`),
  grant `graph/create-node` and `graph/find`, write one node per finished
  round and read the top ten: `graph/find { node_type: "Score", orderBy:
  "points", desc: true, limit: 10 }`.
- **Playing together**: `useChannel` (the App page's "Live between the
  people on an app"). Send your own position as a keyed state 10–20 times a
  second (a sender may send 30 a second) and draw the others between their
  last two states; a move the others must trust (a hit, a win) goes through
  a referee step, which no page can fake.

## Permissions

Every app's frame has fullscreen (and locking the screen's orientation,
which needs it), pointer lock, the gamepad and the screen wake lock (keep
the screen on): a game asks for none of them. What reads the player's
device is granted only when the manifest asks for it:

```yaml
permissions: [motion]
```

`motion` is tilt — device orientation and motion; `camera` and
`geolocation` are the others. List only what the game uses: motion can be
used to guess what a person types, so a game without tilt controls leaves
it out. Vibration is not available in a frame.

## Looking at a game you are building

A canvas has no text for `app/look` to read, so put the game's state where
it can: `window.__debug`, set to a value or to a function returning one —
the phase, the score, the player's position, what the round is about.
`app/look` returns it, and a `{ do: "debug" }` step records it at that
point in the list. Hold keys with `keydown` and `keyup` around a `wait`:

```yaml
steps:
  - { do: click, selector: "text=Start" }
  - { do: debug }
  - { do: keydown, key: ArrowRight }
  - { do: wait, ms: 800 }
  - { do: keyup, key: ArrowRight }
  - { do: debug }
```

The player's x went up, or the movement is broken. The screenshot shows the
scene; the debug values say whether the rules hold.

## What a page cannot do

No worker threads: a page runs only the code its build compiled, and a
worker is code loaded at run time. Keep the work on the main thread —
physics and a few hundred objects at sixty frames a second fit.
