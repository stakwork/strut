/**
 * Git remotes for tests (src/git-hosts.ts): bare repositories served over
 * http on this machine by git's own smart-http backend, optionally behind a
 * token, recording what each request carried — so a test sees exactly
 * which token reached which host. And a shell that points an https URL at a
 * local repository (`url.<local>.insteadOf`), for a test whose remote must
 * be "github.com" without a network.
 */
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage } from "node:http";
import { runProcess, type ProcessRequest, type ProcessResult } from "../shell.js";

export interface GitServer {
  /** `http://127.0.0.1:<port>`: a repository `<root>/<a>/<b>.git` is `${url}/<a>/<b>.git`. */
  url: string;
  /** `127.0.0.1:<port>`, as `provides.git` names it. */
  host: string;
  /** Each request: its path and the password of its Basic auth, if any. */
  seen: Array<{ path: string; password?: string }>;
  close(): Promise<void>;
}

/** The password a request's Basic auth carries. */
function passwordOf(req: IncomingMessage): string | undefined {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Basic ")) return undefined;
  const decoded = Buffer.from(auth.slice("Basic ".length), "base64").toString("utf8");
  return decoded.slice(decoded.indexOf(":") + 1);
}

/**
 * Serve the bare repositories under `root`. With `token`, a request without
 * it as its password is answered 401, as a private repository is. With
 * `redirect`, every request is sent there instead (302), as a host that
 * moved is.
 */
export async function serveGit(root: string, opts: { token?: string; redirect?: string } = {}): Promise<GitServer> {
  const seen: GitServer["seen"] = [];
  const server = createServer((req, res) => {
    const password = passwordOf(req);
    seen.push({ path: req.url ?? "", ...(password !== undefined ? { password } : {}) });
    if (opts.redirect) {
      res.writeHead(302, { location: `${opts.redirect}${req.url ?? ""}` });
      res.end();
      return;
    }
    if (opts.token && password !== opts.token) {
      res.writeHead(401, { "www-authenticate": 'Basic realm="git"' });
      res.end();
      return;
    }
    const u = new URL(req.url ?? "/", "http://git");
    const cgi = spawn("git", ["http-backend"], {
      env: {
        ...process.env,
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: "1",
        PATH_INFO: decodeURIComponent(u.pathname),
        QUERY_STRING: u.search.slice(1),
        REQUEST_METHOD: req.method ?? "GET",
        CONTENT_TYPE: req.headers["content-type"] ?? "",
        HTTP_CONTENT_ENCODING: req.headers["content-encoding"] ?? "",
        HTTP_GIT_PROTOCOL: String(req.headers["git-protocol"] ?? ""),
        // An authenticated user: http-backend then takes pushes too.
        REMOTE_USER: "test",
        REMOTE_ADDR: "127.0.0.1",
      },
    });
    req.pipe(cgi.stdin);
    let head = Buffer.alloc(0);
    let started = false;
    cgi.stdout.on("data", (chunk: Buffer) => {
      if (started) {
        res.write(chunk);
        return;
      }
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end < 0) return;
      started = true;
      let status = 200;
      const headers: Record<string, string> = {};
      for (const line of head.subarray(0, end).toString("utf8").split("\r\n")) {
        const i = line.indexOf(":");
        const [k, v] = [line.slice(0, i).trim(), line.slice(i + 1).trim()];
        if (k.toLowerCase() === "status") status = Number.parseInt(v, 10);
        else headers[k] = v;
      }
      res.writeHead(status, headers);
      res.write(head.subarray(end + 4));
    });
    cgi.stdout.on("end", () => res.end());
    cgi.on("error", () => res.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}`,
    host: `127.0.0.1:${port}`,
    seen,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** A shell whose git reads each remote (an https URL) from its local
 *  repository (a path or file URL), recording each call: a "github.com"
 *  with no network. */
export function insteadOf(remotes: Record<string, string>, calls: ProcessRequest[] = []): (req: ProcessRequest) => Promise<ProcessResult> {
  const config = Object.entries(remotes).flatMap(([remote, local]) => ["-c", `url.${local}.insteadOf=${remote}`]);
  return (req) => {
    calls.push(req);
    if (req.cmd !== "git") return runProcess(req);
    return runProcess({ ...req, args: [...config, ...(req.args ?? [])] });
  };
}
