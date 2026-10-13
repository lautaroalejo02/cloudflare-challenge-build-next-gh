import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createArbServer } from "./server.ts";
import { ArbService, resolveConfig } from "./service.ts";

// Local stdio MCP server. Everything log-worthy goes to stderr — stdout is the
// JSON-RPC channel and must stay clean. No secret (admin key, repo tokens) is
// ever written to either stream.

const cfg = resolveConfig();
const service = new ArbService(cfg);
const server = createArbServer(service);

await server.connect(new StdioServerTransport());
console.error(
  `arb-mcp ready: base=${cfg.baseUrl} workdir=${cfg.workdir} adminKey=${cfg.adminKey ? "set" : "none"}`,
);
