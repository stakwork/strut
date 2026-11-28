# Agent containers: Claude Code and other ACP agents, one container per person

> **Status (2026-11-27): proposed. Nothing is built.** Written from a
> design conversation with the owner on 2026-11-27. In "Decided",
> **owner** rows are his words; every other row is *proposed*. Read
> against strut `main` @b3dd78c0 and stakwork/pods @3aab5a4. Companions:
> `pods.md` §1 (the `Host` seam, "The seam in code") and §6 (other agents
> in a pod), stakwork/pods `PLAN.md` §3.1 (podd's stream for an ACP agent),
> `mothership-cost-control.md` (the gateway and its grants).

## Goal

A person on a shared strut box has a job done by Claude Code, Codex,
Gemini CLI or opencode. The agent runs in a container of its own for that
turn. It sees only the job's folder and that person's home folder, and
it signs in with its own login or uses the gateway. Nobody else's runs see
that login, and strut never holds it.

## Problem

`acp/prompt` (src/steps/lib/acp/prompt.ts) already runs a local coding
agent over ACP, and the `job` workflow uses it instead of strut's `agent`
when a launch names `input.agent` (src/workflows/job.yaml, the `local`
step). It starts the agent as a child process of strut
(src/steps/lib/acp/_client.ts) with `minimalEnv()`, so `HOME` is strut's.
That's right on a person's own machine and wrong on a shared box:

- **One login for everyone.** Every person's turns run on whichever
  account signed in to the agent on that box. Anthropic's terms forbid
  that (below).
- **No wall between people.** The agent's bash runs in strut's container,
  beside the data folder, the secret stores and every job.
- **No strut tools.** `session/new` gets `mcpServers: []`
  (prompt.ts:297): the agent can edit files and run commands, nothing
  else.
- **No instructions.** The `local` step sends the prompt alone, without
  the Job and kind pages the `work` step reads into its system prompt.

## Anthropic's terms

Checked on 2026-11-27 against code.claude.com/docs/en/legal-and-compliance
("Can customers offer Claude Code in their products?", "Authentication and
credential use"), code.claude.com/docs/en/authentication and
code.claude.com/docs/en/devcontainer. Re-read them before building §4 and
§5: they change.

- **Allowed:** a product may run Claude Code, "e.g. in hosted sandboxes or
  other agent infrastructure". Conditions: the operator accepts
  Anthropic's Commercial Terms. The binary runs unmodified, with none of
  its sign-in methods removed. Each person uses their own API key,
  subscription or cloud-provider credential. An end user signing in to the
  unmodified binary with their own subscription is explicitly allowed,
  also where a platform hosts it.
- **Forbidden:**
  - an app offering its own Claude.ai login (sign-in has to finish in
    Anthropic's own flow)
  - running requests on Free, Pro, Max or Ultra plans on behalf of the
    app's users
  - collecting, storing or passing on Claude.ai credentials or session
    tokens
  - paying for, reselling or passing on Claude usage for end users
- **Gray areas:**
  - Products built on the Agent SDK are told to use API keys, and the
    claude ACP adapter is built on the Agent SDK. Is a strut job that
    drives Claude Code a product built on Claude, or a platform hosting
    Claude Code? The adapter doesn't decide it: driving `claude -p` would
    raise the same question.
  - Plan limits assume ordinary, individual use.
- **What follows:**
  - API keys first. A person's own login is a deployment setting, off by
    default (§4).
  - Before offering it as a feature, describe this design to Anthropic and
    get a yes. Both sections allow exceptions by agreement.
  - A hosted box's gateway key for Claude Code should be the client's own,
    not a key Stakwork pays for and re-bills.
  - The UI may say in plain text that a job runs Claude Code. It may not
    use the name in a strut feature's name (§5).

## Decided

| # | Question | Answer | Status |
| --- | --- | --- | --- |
| 1 | Where does a coding agent run for a person on a shared box? | **In a container for each turn:** the job's folder, that person's home folder, nothing else. | **owner** (2026-11-27: "yes, this is the right way") |
| 2 | Do local containers need podd or the pods service? | **No.** A container is one more way for `acp/prompt` to start the agent, with ACP over its stdin and stdout as today. podd exists to reach a dev environment over a network. | **owner** ("why would we need all that podd stuff for direct connection with agent on local machine") |
| 3 | What's open source? | **All of this, in strut.** The pods service, podd, the AWS template and Lambda pods stay proprietary. They meet strut only through the pods package's host (§9). | **owner** ("Cant the aws+podd stay our proprietary thing while the rest is open source?") |
| 4 | strut core or the strut-pods package? | **Core.** It isn't pods. A package step can't start a process or open a socket (step-lint's `RISKY_MODULES`). And it's how a shared box runs agents safely, which shouldn't depend on a package. | **owner** (2026-11-27: "got it") |
| 5 | A new image? | **None.** The launcher is a second container of strut's own image. Agent containers run strut's image too, which already has git, rg, Python, pandoc and uv. | **owner** (the reason he asked: "YET ANOTHER container and image to pull into Stadeum") |
| 6 | The launcher's language? | **TypeScript, in strut.** On a laptop strut runs the same module in process, so the shape check exists once (§3). | **owner** ("got it", after the image answer) |
| 7 | Which agents? | **Any ACP agent with a pinned npm package:** claude, codex, gemini, opencode. goose isn't on npm: later. | **owner** ("of course it needs to work for other ones later on (grok, gemini, etc)") |
| 8 | Does strut store a person's agent token? | **No.** The person signs in through the agent's own login in a terminal (§5). The login lives in their home folder volume. | **owner** (he wasn't sure about storing tokens; this design needs none) |
| 9 | Which login does a turn use? | **The person's own, when they started the turn and have signed in; otherwise a gateway grant. Never both,** because Claude Code prefers an API key (§4). | **owner** ("ok this sounds good") |
| 10 | Own logins on or off? | **Off by default**, a deployment setting, until Anthropic confirms (above). | proposed |
| 11 | strut's tools for the agent? | **Yes, over MCP, for this host:** a token per turn, the job's grants, gated as they are for strut's agent (§6). This reverses `pods.md` §6's "learns nothing" for containers only. Pods keep that rule. | proposed: the owner's call |
| 12 | How does a container job use a pod? | **Through the pods package's tools, from the container (the default):** it claims the pod and codes in it with `bash` and `edit`, as strut's agent does today, and keeps the person's login. Running the agent inside the pod (`host: pod`) is an option on the gateway alone (§9). | proposed |
| 13 | A wake turn of a person's own job (CI came back, a run ended)? | **The person's own login,** like a turn they sent: it's their job going on. | **owner** (2026-11-27: "wake turn should be a person's login") |

## Design in one paragraph

`acp/prompt` gets a `host`: `local` (today: a child of strut), `container`
(this plan) or `pod` (`pods.md` §6). For `container`, strut asks a launcher
to start `docker run -i --rm` of strut's own image as a non-root user,
with three mounts: the job's folder at `/work`, the person's home folder
volume at `/home/agent`, and the agent programs volume read-only at
`/opt/agents`. The agent's stdin and stdout come back over the launcher's
socket, and strut speaks ACP over them exactly as it does with a local
child. The container gets a gateway grant's variables only when the turn
isn't using the person's own login. strut passes the agent an MCP server
for this turn with the job's tools, and the Job and kind pages in the
prompt. On a laptop strut runs the launcher module in process. On a
shared box the launcher is a second container that alone holds the Docker
socket.

## 1. Where an agent runs: `host`

`acp/prompt { host }`: `local | container | pod`. `pods.md` §1 already
names the seam: one `Host` interface that runs a command with a two-way
stream, kills it, and reads, writes and stats files. `localHost` is
today's spawn in `_client.ts` moved behind it. `AcpClient` takes a stream
instead of spawning.

- **`local`:** a person's own strut on their own machine, with the agent
  they installed and their login. Unchanged.
- **`container`:** this plan. Files are on strut's own disk (the job's
  folder), so they're read and written with `node:fs` as for `local`. Only
  starting the process differs.
- **`pod`:** supplied by the pods package (§9).

The default is `container` where the launcher is set up, else `local`.
The `job` workflow's `local` step passes no `host`, so it gets the
default.

## 2. The container

### 2.1 The command

What the launcher creates through Docker's API, written as a command line:

```text
docker run -i --rm --name strut-agent-<run>-<n> \
  --user 1000:1000 --cap-drop ALL --security-opt no-new-privileges \
  --pids-limit … --memory … --cpus … --network strut-agents \
  --mount type=volume,src=<workspace volume>,dst=/work,volume-subpath=jobs/<job> \
  --mount type=volume,src=strut-home-<person>,dst=/home/agent \
  --mount type=volume,src=strut-agents,dst=/opt/agents,readonly \
  -e HOME=/home/agent [grant variables] \
  <strut's image> /opt/agents/<set>/node_modules/.bin/<agent's ACP command>
```

- No `--privileged`, no Docker socket, no other mount, no strut variable.
- **The network:** `strut-agents` reaches the internet and strut (for the
  MCP door, §6), not Neo4j or the browser. strut joins both networks.
  Neo4j stays on the default one.
- **Limits:** the launcher's settings, the same for every agent.

### 2.2 The job's folder

- **Mount source:** Docker resolves mount sources on the host, not inside
  strut's container. On a Stadeum box strut's data is the named volume
  `strut-workspace` (docker-compose.yml:119), so the job's folder is a
  `volume-subpath` mount (Docker Engine 26 or newer). On a laptop, where
  strut isn't in Docker, it's a bind mount of the real folder.
- **Paths:** the agent sees `/work`. `acp/prompt` sends `cwd: "/work"` and
  maps the paths in tool calls back to the job's folder (`artifacts`
  already reports paths relative to cwd).
- **`input.cwd`:** a host's own checkout outside the job's folder isn't
  allowed with `container`. The launcher mounts nothing outside `jobs/`.
- **Owners:** strut runs as root, so what it writes into a job's folder
  (`git/checkout`, `app/checkout`) is root's. Before each turn the
  container host hands the job's folder to the agent's user (`chown -R`,
  skipped when it already owns it). strut, as root, still reads and writes
  everything.

### 2.3 The person's home folder

- **One volume per person:** `strut-home-<sha256(actor), 16 hex>`.
- **What it keeps:** the agent's login (§5) and its own history: Claude
  Code's `~/.claude`, Codex's `~/.codex`, Gemini's `~/.gemini`. So
  `session/load` continues a thread from turn to turn.
- **Threads per person:** `<dataDir>/acp/sessions/` maps strut's session
  name and the person to the agent's session id, because a thread lives
  in one person's home folder.
- **A turn with no person:** an anonymous volume that `--rm` removes. It
  never has a login.
- **Removing a person** deletes their volume.

### 2.4 The agent programs

- **One volume,** `strut-agents`. Agent containers mount it read-only, so
  no agent can change what the next person runs.
- **Who fills it:** the launcher, on first use, in a container of strut's
  image that can write the volume: `npm install --prefix
  /opt/agents/<set>` of the pinned packages, then it moves `current` to
  the new set. A version bump is a new set; the old one goes when no
  container uses it.
- **One list of pins,** replacing `ACP_PRESETS`' `npx -y` commands
  (prompt.ts:35).
- **Unpacked sizes on npm, 2026-11-27:**
  - Claude Code's linux-x64 binary package
    (`@anthropic-ai/claude-agent-sdk-linux-x64`): about 400 MB
  - opencode's: about 216 MB
  - `@google/gemini-cli`: about 122 MB
  - the claude and codex ACP adapters: about 2 MB each, plus
    `@openai/codex`, which the codex adapter depends on (not measured)

  They're on disk once, and only on boxes that use agents. Nothing is
  added to an image.
- **Unmodified:** npm installs Anthropic's own package, so Claude Code
  stays the binary as published.

## 3. The launcher

- **One module** (`src/agent-launcher/`). Each request names the agent,
  the person, the job and the variables. The module checks the request,
  then creates, attaches, starts and removes the container through
  Docker's HTTP API (`node:http` with `socketPath`, no Docker CLI). It
  pipes the agent's stdout to the caller, keeps its stderr in a log, and
  stops the container when the caller goes away.
- **The shape check,** one pure function with offline tests:
  - the image is strut's own
  - the user is the agent's
  - exactly the three mounts of §2.1
  - the job's folder name as strut encodes it (`encodeId`,
    src/jobs.ts:320), with no `/` or `..`, naming a folder that exists
    under `jobs/`
  - variables only from the allowed names (`HOME`, `TERM`, the grant's)
  - the network is `strut-agents`
  - nothing else
- **On a laptop:** strut calls the module in process. It talks to the
  Docker the person already runs, and the agent's bash has no more reach
  than it has today.
- **On a shared box:** the same module runs as a second container of
  strut's image (`node --import tsx build/agent-launcher.js`, as the
  server's `CMD` runs `build/server.js`). It alone mounts
  `/var/run/docker.sock`, and it listens on a Unix socket in a volume only
  it and strut mount. Each connection carries one agent: a first line of
  JSON, then the agent's raw stdin and stdout. strut never gets the Docker
  socket, because the `agent` step's bash runs in strut's container and
  could start a privileged container.
- **Setting:** `STRUT_AGENT_LAUNCHER`: `docker` (in process) or the
  socket's path. Unset: no `container` host.

## 4. Which login a turn uses

When a deployment allows own logins (`STRUT_AGENT_OWN_LOGINS=1`, off by
default), the person's own login is used for a turn only when both hold:

- **The run is that person's own:** the run's principal launched it,
  directly or through their own chat or job. Not an automation running as
  its owner (`runsAs`), a visitor, a public run, a peer, or another
  person's message in a shared job.
- **Their home folder has that agent's login:** Claude Code's credentials
  file under `~/.claude`, Codex's `~/.codex/auth.json`, Gemini's
  `~/.gemini/oauth_creds.json`. Confirm each path before building.

Otherwise the container gets a grant: `ctx.services.llm.grant({ name,
hours })` → `{ id, env }` (src/capabilities.ts, `grantEnv` in
src/mothership.ts: `ANTHROPIC_*`, `OPENAI_*`, `GEMINI_*` on the
gateway's routes). The grant is billed to the run's principal, set in
that container's environment alone, and revoked when the turn ends.

- **Never both,** because Claude Code uses an API key over a subscription
  when both are set.
- **No grant service** (a box without the Mothership): only own logins.
  Otherwise `no_login:`, with an `ask` to sign in. A deployment's raw
  provider key never goes into a container.
- **strut's own agent, the orchestrator and the chat** never use a
  person's login. They aren't Claude Code.
- **A plan's usage limit hit mid-turn:** the turn ends with the agent's
  message. The next turn uses whatever the rule says then.

## 5. Signing in

- **The terminal:** a person opens a terminal to a container with their
  home folder (launcher request `signin`, a TTY) running the agent's own
  login: `claude` then `/login`, `codex login`, `gemini`. The sign-in
  finishes in the agent vendor's own flow. strut relays the terminal's
  bytes over a WebSocket and never records or logs them. Only a person's
  own session opens their terminal.
- **The UI:** the person's settings list the agents, each with **Sign in**
  and, once signed in, **Sign out**, which deletes that agent's login
  from their home folder. The agent's name appears as itself. No strut
  feature is named after it, and there's no "Sign in with Claude".
- **Hidden** when own logins are off.

## 6. strut's tools over MCP

- **Which tools:** the job's grants (`params.tools` and `approve` in
  job.yaml). They're built as the `agent` step builds them: registry
  steps, registered MCP servers, the caller's MCP servers, masking, run
  events and approvals that become proposals. That building moves out of
  src/steps/core/agent.ts into a module both use.
- **How they're served:** `toolsetServer` (src/ai/mcp.ts) on a route for
  the turn. Its token is minted for that turn (an HMAC like the file
  token), opens that route alone, and dies when the turn ends.
- **How the agent gets them:** `session/new` and `session/load` pass
  `mcpServers: [{ type: "http", name: "strut", url, headers }]`. An agent
  without HTTP MCP support gets none, and `acp/prompt` warns.
- **They run in strut,** as the run's person, as they do for strut's
  agent.
- **The trade-off:** code in the job's folder, such as a repo's install
  script the agent runs, can read the token while the turn lasts. Inside
  the job's grants it can do what the agent can, and writes still go
  through proposals. `pods.md` §6 refused this for pods. Decided 11 asks
  the owner for containers.

## 7. What the agent is told and what it answers

- **The pages:** the Job page, the kind page and recent work (the inputs
  of job.yaml's `work` step) open the first turn of a thread. They come
  again only when the kind changes. Everything else in the graph the
  agent looks up itself, with the graph and knowledge tools of §6.
- **The answer:** with a `schema`, the job's reply shape becomes the MCP
  tool `final_answer`, and `acp/prompt` returns the input of its last
  call as `object`. job.yaml's `result` reads `local?.object` beside
  `work?.object`. Without a call, `text`, as today.

## 8. What a job gives up in a container

- **A shared job's thread splits by person:** each person continues their
  own thread in their own home folder. Today a job has one thread.
- **No ssh agent:** the `sshKeys` socket (src/ssh-agent.ts) isn't mounted.
- **Models:** whatever the agent supports. strut's `agent` step remains
  for every model aieo routes.
- **No Docker inside the container:** work that needs running services
  claims a pod and works in it through the pod's tools (§9).
- **A thinner record:** strut keeps the agent's tool calls and replies as
  run events, not the model's transcript, so claims and the graph get
  less from such a turn.
- **No Mothership cap on own-login turns:** the person's plan limits them
  instead.

## 9. Pods

No change to pods for this plan. A job can use a pod in two ways.

**From the container, through the pods package's tools (the default).**
The package grants the job agent `claim`, `bash`, `edit`, `git`, `url`,
`bake` and `release` (stakwork/pods `package/strut.yaml`, `job:`). They
are strut steps, so §6 serves them to a container agent as it serves
every grant. The agent claims the job's pod and codes in it through
`bash` and `edit`, exactly as strut's `agent` does today. Its model calls
stay in the container, so the person's own login still applies (§4). Its
own file and shell tools act on `/work`, the job's folder, and the pod's
tools act on the pod: strut's agent has the same two places today. The
`Pod` page tells it which is which.

**Inside the pod (`host: pod`, `pods.md` §6, stakwork/pods `PLAN.md`
§3.1).** The pods package supplies that host through the same seam (§1).
The agent's own tools then act on the pod's disk directly. Only the grant
applies, since a pod has no lasting home folder (one per job, at most 8
hours, and an AWS pod can't mount the box's disk). And per `pods.md` §6
it learns nothing unless the owner rules otherwise. An option for heavy
repo work, not the default.

## 10. What not to do

- No podd and no pods service for local containers.
- No new image. No agent programs baked into strut's image.
- No Docker socket in strut's container.
- No agent token in strut: not in a secret store, not in a variable.
- No person's login for anyone else's run, an automation, a visitor or a
  public run. Never for strut's own agent.
- No deployment provider key in a container.
- No mount of the data folder, only `jobs/<job>`.

## Open questions

1. While a job holds a pod, should the agent's own file and shell tools be
   turned off (ACP mode or the agent's settings), so it works only through
   the pod's tools (§9)? Proposed: no; the Pod page says where the code is.
2. One thread per person in a shared job (§8): accept, or keep a home
   folder per job instead (which would then hold the login of whoever
   signed in there)? Proposed: accept.
3. Pages on the first turn of a thread only, or every turn (§7)?
4. The `chown -R` before each turn on a big job's folder (`node_modules`):
   cost, or a shared group instead?
5. The credentials path of each agent (§4), and whether each supports HTTP
   MCP servers (§6).
6. With the launcher set up, should `host: local` be refused, so a shared
   box can't fall back to one login?
7. Anthropic's answer on own logins (above).
8. Whose provider keys the hosted Mothership uses (the resale rule).

## Work items

Each is its own PR against `main`, in this order.

1. **The seam.** `Host` and `localHost` (`pods.md` §1), `AcpClient` over a
   stream, `acp/prompt { host }`. Nothing else changes: the acp tests pass
   through `localHost`.
2. **The container host and the launcher module, in process.** The shape
   check (offline tests), the Docker API client, the agent programs volume
   and its pins, home folder volumes, path mapping, the owner hand-off,
   the grant. Gateway grants only. A live suite behind
   `STRUT_TEST_DOCKER=1` runs a stand-in ACP agent in a container. Docs:
   `docs/agent-step.md`, `docs/environment.md`.
3. **The launcher container.** Its entry point, the Unix socket protocol,
   the compose service and network, `docs/running.md`.
4. **strut's tools over MCP.** The toolset module out of agent.ts, the
   route and token for each turn, `final_answer`, and job.yaml's `local`
   step with pages and `object`. Docs: `docs/agent-step.md`,
   `docs/jobs.md`.
5. **Own logins.** The sign-in terminal (launcher `signin`, the WebSocket
   route, the settings UI) and §4's rule behind `STRUT_AGENT_OWN_LOGINS`.
   Docs: `docs/security.md`. Only after Anthropic's answer.

## Validation

On a laptop with Docker and `STRUT_AGENT_LAUNCHER=docker`, then on a box
with the launcher container:

1. A job with `agent: claude` on the grant edits a file in its folder. The
   file is there, owned so strut reads it, and the turn's tool calls are
   run events.
2. A second person's turn on another job runs in their own home folder and
   sees nothing of the first person's.
3. The launcher refuses a request with `..` in the job name, an extra
   mount or a variable outside the list.
4. With own logins on: a person signs in through the terminal, and their
   next turn has no grant variables. An automation running as them gets
   the grant.
5. The agent calls `app/look` and `final_answer` over MCP. The look runs
   in strut, and the job's reply carries the object.
6. The same with `agent: codex` and `agent: gemini`.
