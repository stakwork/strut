import http from "node:http";

/** A tool a stand-in MCP server offers: its result is an MCP `CallToolResult`. */
export interface StandInTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  call: (args: Record<string, unknown>) => unknown;
}

export interface StandInMcp {
  url: string;
  /** Every tools/call: the tool, its arguments, the Authorization it carried. */
  calls: Array<{ name: string; args: Record<string, unknown>; authorization?: string }>;
  /** Every request's Authorization header, in order. */
  authorizations: Array<string | undefined>;
  close: () => Promise<void>;
}

/**
 * A caller's MCP server for tests: the SDK's own server over Streamable
 * HTTP, stateless (a fresh server + transport per POST, as strut's door
 * does). With `token`, a request without `Authorization: Bearer <token>` is
 * a 401, as a real one refuses it.
 */
export async function standInMcp(tools: StandInTool[], opts: { token?: string } = {}): Promise<StandInMcp> {
  const [{ Server }, { StreamableHTTPServerTransport }, types] = await Promise.all([
    import("@modelcontextprotocol/sdk/server/index.js"),
    import("@modelcontextprotocol/sdk/server/streamableHttp.js"),
    import("@modelcontextprotocol/sdk/types.js"),
  ]);
  const calls: StandInMcp["calls"] = [];
  const authorizations: StandInMcp["authorizations"] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", async () => {
      const authorization = req.headers.authorization;
      authorizations.push(authorization);
      if (req.method !== "POST") return void res.writeHead(405).end();
      if (opts.token && authorization !== `Bearer ${opts.token}`) return void res.writeHead(401).end("unauthorized");
      const mcp = new Server({ name: "stand-in", version: "1" }, { capabilities: { tools: {} } });
      mcp.setRequestHandler(types.ListToolsRequestSchema, async () => ({
        tools: tools.map((t) => ({
          name: t.name,
          ...(t.description ? { description: t.description } : {}),
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
    close: () =>
      new Promise<void>((r) => {
        server.close(() => r());
        server.closeAllConnections();
      }),
  };
}
