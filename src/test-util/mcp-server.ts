import { randomUUID } from "node:crypto";
import http from "node:http";

/** A tool a stand-in MCP server offers: its result is an MCP `CallToolResult`. */
export interface StandInTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean };
  call: (args: Record<string, unknown>) => unknown;
}

export interface StandInMcp {
  url: string;
  /** Every tools/call: the tool, its arguments, the Authorization it carried. */
  calls: Array<{ name: string; args: Record<string, unknown>; authorization?: string }>;
  /** Every request's Authorization header, in order. */
  authorizations: Array<string | undefined>;
  /** With `sessions`: forget every session, so the next request naming one is a 404. */
  dropSessions: () => void;
  close: () => Promise<void>;
}

/**
 * A caller's MCP server for tests: the SDK's own server over Streamable
 * HTTP, stateless (a fresh server + transport per POST, as strut's door
 * does). With `token`, a request without `Authorization: Bearer <token>` is
 * a 401, as a real one refuses it. With `sessions`, an initialize hands out
 * an `Mcp-Session-Id` and a request naming one the server no longer knows is
 * a 404, as a stateful server's after a restart.
 */
export async function standInMcp(tools: StandInTool[], opts: { token?: string; sessions?: boolean } = {}): Promise<StandInMcp> {
  const [{ Server }, { StreamableHTTPServerTransport }, types] = await Promise.all([
    import("@modelcontextprotocol/sdk/server/index.js"),
    import("@modelcontextprotocol/sdk/server/streamableHttp.js"),
    import("@modelcontextprotocol/sdk/types.js"),
  ]);
  const calls: StandInMcp["calls"] = [];
  const authorizations: StandInMcp["authorizations"] = [];
  const sessions = new Set<string>();
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", async () => {
      const authorization = req.headers.authorization;
      authorizations.push(authorization);
      if (req.method !== "POST") return void res.writeHead(405).end();
      if (opts.token && authorization !== `Bearer ${opts.token}`) return void res.writeHead(401).end("unauthorized");
      if (opts.sessions) {
        const sid = req.headers["mcp-session-id"];
        if (typeof sid === "string" && !sessions.has(sid)) return void res.writeHead(404).end("no such session");
        if (raw && JSON.parse(raw).method === "initialize") {
          const id = randomUUID();
          sessions.add(id);
          res.setHeader("mcp-session-id", id);
        }
      }
      const mcp = new Server({ name: "stand-in", version: "1" }, { capabilities: { tools: {} } });
      mcp.setRequestHandler(types.ListToolsRequestSchema, async () => ({
        tools: tools.map((t) => ({
          name: t.name,
          ...(t.description ? { description: t.description } : {}),
          ...(t.annotations ? { annotations: t.annotations } : {}),
          inputSchema: (t.inputSchema ?? { type: "object", properties: {} }) as { type: "object" },
        })),
      }));
      mcp.setRequestHandler(types.CallToolRequestSchema, async ({ params }) => {
        const args = (params.arguments ?? {}) as Record<string, unknown>;
        calls.push({ name: params.name, args, ...(authorization ? { authorization } : {}) });
        const tool = tools.find((t) => t.name === params.name);
        if (!tool) throw new types.McpError(types.ErrorCode.InvalidParams, `Unknown tool: ${params.name}`);
        return (await tool.call(args)) as never;
      });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, raw ? JSON.parse(raw) : undefined);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`,
    calls,
    authorizations,
    dropSessions: () => sessions.clear(),
    close: () =>
      new Promise<void>((r) => {
        server.close(() => r());
        server.closeAllConnections();
      }),
  };
}
