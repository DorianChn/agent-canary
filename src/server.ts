import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { DECOY_TOOLS, DECOY_TOOL_ANNOTATIONS, handleDecoyCall } from "./decoys.js";
import { VERSION } from "./config.js";

/**
 * Runs the decoy MCP server on stdio. All server-side chatter goes to stderr;
 * stdout is reserved for the MCP protocol.
 */
export async function serve(): Promise<void> {
  const server = new Server({ name: "agent-canary", version: VERSION }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: DECOY_TOOLS.map((t) => ({
      name: t.name,
      title: t.title,
      description: t.description,
      inputSchema: t.inputSchema,
      annotations: { title: t.title, ...DECOY_TOOL_ANNOTATIONS },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) =>
    handleDecoyCall(req.params.name, (req.params.arguments ?? {}) as Record<string, unknown>)
  );

  await server.connect(new StdioServerTransport());
  console.error("[agent-canary] decoy server ready on stdio");
}
