// `strut move …` (AGENTS.md, "Moving strut to another host"): run over a
// STOPPED strut's folders, beside the server, never inside it. The desktop
// package runs it as `node desktop.js move …`; anywhere else,
// `node build/move/cli.js …`. Machine-readable results go to stdout as one
// JSON line each; words and the QR code go to stderr. Exit 0 done, 1
// refused or failed, 2 usage.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { bootEnv } from "../env.js";
import { SIDECAR_NAME, type Endpoint, type MoveFolders } from "./archive.js";
import { check, fetchMove, send } from "./client.js";
import { qrTerminal } from "./link.js";
import { groupCode } from "./seal.js";
import { serve } from "./serve.js";

const USAGE = `usage: strut move <command>

  check <link>                 the other end's mode, once its version matches and it takes the code
  send <link>  [folders]       pack this host's stopped folders and send them
  serve        [folders] [--send-back] [--listen [host:]port] [--host <h[:port]>] [--link <prefix>] [--name <n>]
                               empty data folder: receive one move; --send-back: serve this host's folders once
  fetch <link> [folders]       download a sent-back move and put it in place here

folders (each command reads or writes the same ones):
  --data <dir>                 strut's data folder (default STRUT_WORKSPACE)
  --host-config <file>         STRUT_HOST_CONFIG's file (default STRUT_HOST_CONFIG)
  --sidecar <name>=<path>      a folder (or file) moved alongside, opaque; repeatable
  --env <file>                 strut's env values (send: also <name>.KEY for a sidecar's); not
                               --env-file, which node takes for itself even after the script
  --sidecar-env <name>=<file>  a sidecar's env values; repeatable
  --state <dir>                codes and staging (default <data's parent>/.move)

this host's bridge, for moved.json (serve, fetch) and the callbacks a move names (send, serve --send-back):
  --bridge <url>               its token in STRUT_MOVE_BRIDGE_TOKEN
  --set-secret <NAME>=<value>  a secret moved.json sets; {bridge.url} {bridge.port} {bridge.token} fill in; repeatable`;

class Usage extends Error {}

interface Parsed {
  positional: string[];
  flags: Map<string, string[]>;
}

const VALUED = new Set(["data", "host-config", "sidecar", "env", "sidecar-env", "state", "bridge", "set-secret", "listen", "host", "link", "name"]);

function parse(args: string[]): Parsed {
  const out: Parsed = { positional: [], flags: new Map() };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith("--")) {
      out.positional.push(a);
      continue;
    }
    const [name, inline] = a.slice(2).split(/=(.*)/s, 2) as [string, string | undefined];
    if (name === "send-back") {
      out.flags.set(name, ["1"]);
      continue;
    }
    if (!VALUED.has(name)) throw new Usage(`unknown option --${name}`);
    const value = inline ?? args[++i];
    if (value === undefined) throw new Usage(`--${name} needs a value`);
    out.flags.set(name, [...(out.flags.get(name) ?? []), value]);
  }
  return out;
}

function pairs(values: string[] | undefined, flag: string, nameOk: (n: string) => boolean): Record<string, string> {
  const out: Record<string, string> = {};
  for (const v of values ?? []) {
    const eq = v.indexOf("=");
    const name = v.slice(0, eq);
    if (eq < 1 || !nameOk(name)) throw new Usage(`--${flag} takes <name>=<value>, got ${JSON.stringify(v)}`);
    out[name] = v.slice(eq + 1);
  }
  return out;
}

function folders(p: Parsed): MoveFolders & { state?: string } {
  const env = bootEnv();
  const one = (k: string) => p.flags.get(k)?.at(-1);
  const data = one("data") ?? env["STRUT_WORKSPACE"];
  if (!data) throw new Usage("--data is required (or STRUT_WORKSPACE)");
  const hostConfig = one("host-config") ?? env["STRUT_HOST_CONFIG"];
  const sidecars = pairs(p.flags.get("sidecar"), "sidecar", (n) => SIDECAR_NAME.test(n));
  const sidecarEnv = pairs(p.flags.get("sidecar-env"), "sidecar-env", (n) => SIDECAR_NAME.test(n));
  return {
    data,
    ...(hostConfig ? { hostConfig } : {}),
    ...(Object.keys(sidecars).length ? { sidecars } : {}),
    ...(one("env") ? { envFile: one("env")! } : {}),
    ...(Object.keys(sidecarEnv).length ? { sidecarEnv } : {}),
    ...(one("state") ? { state: one("state")! } : {}),
  };
}

function bridge(p: Parsed): Endpoint | undefined {
  const url = p.flags.get("bridge")?.at(-1);
  if (!url) return undefined;
  const token = bootEnv()["STRUT_MOVE_BRIDGE_TOKEN"];
  if (!token) throw new Usage("--bridge needs its token in STRUT_MOVE_BRIDGE_TOKEN");
  return { url, token };
}

const out = (event: Record<string, unknown>) => process.stdout.write(`${JSON.stringify(event)}\n`);

export async function main(args: string[]): Promise<number> {
  try {
    const [command, ...rest] = args;
    if (command === "--help" || command === "-h" || command === "help") {
      console.log(USAGE);
      return 0;
    }
    const p = parse(rest);
    const link = () => {
      const l = p.positional[0];
      if (!l) throw new Usage(`move ${command} needs a link`);
      return l;
    };
    switch (command) {
      case "check": {
        out({ event: "checked", ...(await check(link())) });
        return 0;
      }
      case "send": {
        const b = bridge(p);
        const m = await send(link(), folders(p), b ? { bridge: b } : {});
        out({ event: "sent", from: m.from, sidecars: m.sidecars });
        return 0;
      }
      case "fetch": {
        const b = bridge(p);
        const secrets = pairs(p.flags.get("set-secret"), "set-secret", (n) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(n));
        const f = folders(p);
        const m = await fetchMove(link(), f, { ...(b ? { bridge: b } : {}), ...(Object.keys(secrets).length ? { secrets } : {}), ...(f.state ? { state: f.state } : {}) });
        out({ event: "fetched", from: m.from, sidecars: m.sidecars });
        return 0;
      }
      case "serve": {
        const env = bootEnv();
        const b = bridge(p);
        const secrets = pairs(p.flags.get("set-secret"), "set-secret", (n) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(n));
        const listen = p.flags.get("listen")?.at(-1) ?? env["STRUT_MOVE_LISTEN"] ?? "8090";
        const m = /^(?:(.+):)?(\d+)$/.exec(listen);
        if (!m) throw new Usage(`--listen takes [host:]port, got ${JSON.stringify(listen)}`);
        const publicHost = p.flags.get("host")?.at(-1) ?? env["STRUT_MOVE_HOST"];
        const linkPrefix = p.flags.get("link")?.at(-1) ?? env["STRUT_MOVE_LINK"];
        const name = p.flags.get("name")?.at(-1);
        const result = await serve({
          ...folders(p),
          port: Number(m[2]),
          ...(m[1] ? { host: m[1] } : {}),
          ...(publicHost ? { publicHost } : {}),
          ...(linkPrefix ? { linkPrefix } : {}),
          ...(name ? { name } : {}),
          ...(b ? { bridge: b } : {}),
          ...(Object.keys(secrets).length ? { secrets } : {}),
          sendBack: p.flags.has("send-back"),
          onReady: ({ link: l, code, port, mode }) => {
            out({ event: "ready", mode, link: l, code, port });
            console.error(`\n${mode === "receive" ? "Waiting for a move." : "Packed and ready to send back."} Open this link where it should go:\n\n  ${l}\n\nCode: ${groupCode(code)}\n`);
            console.error(qrTerminal(l));
          },
        });
        out({ event: result });
        if (result === "already-here") console.error("strut is already on this host; nothing to receive (--send-back sends it back)");
        return 0;
      }
      default:
        throw new Usage(command ? `unknown command ${JSON.stringify(command)}` : "no command");
    }
  } catch (err) {
    if (err instanceof Usage) {
      console.error(`strut move: ${err.message}\n\n${USAGE}`);
      return 2;
    }
    console.error(`strut move: ${err instanceof Error ? err.message : err}`);
    out({ event: "error", error: err instanceof Error ? err.message : String(err) });
    return 1;
  }
}

// Run directly: `node build/move/cli.js serve …`.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = await main(process.argv.slice(2));
}
