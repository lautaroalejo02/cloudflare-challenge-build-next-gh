import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { redactCredentials } from "../../demo/src/lib/git.ts";
import type { ArbService } from "./service.ts";

// Tool input schemas (zod v4; the SDK validates before the handler runs).
const registerSchema = z.object({
  agent: z.string().min(1).describe("Agent display name recorded on the buffer entry"),
  lane: z.string().min(1).describe("Display lane, e.g. \"api\", \"ui\", \"tests\""),
  producerId: z
    .string()
    .min(1)
    .optional()
    .describe("Entry id this one consumes from (forks the producer's unfinished fork). Omit to fork trunk."),
  consumes: z
    .array(z.string().min(1))
    .optional()
    .describe("Producer symbol names this entry depends on. Omit to let the control plane infer them from imports."),
  stub: z
    .record(z.string(), z.string())
    .optional()
    .describe("Value prediction: path -> TypeScript source declaring your intended exported signatures."),
});

const entryIdSchema = z.object({
  entryId: z.string().min(1).describe("Buffer entry id returned by arb_register (e.g. \"e3\")"),
});

const syncSchema = entryIdSchema.extend({
  timeoutMs: z
    .number()
    .int()
    .positive()
    .max(600_000)
    .optional()
    .describe("Max milliseconds to wait for the re-fork to land (default 120000)."),
});

const pushSchema = entryIdSchema.extend({
  message: z.string().min(1).describe("Commit message for all workspace changes"),
});

type ToolResult = {
  isError?: boolean;
  content: Array<{ type: "text"; text: string }>;
};

function ok(data: unknown): ToolResult {
  // Defense in depth: even though tool results never carry tokens, run the
  // serialized output through the credential scrubber anyway.
  return { content: [{ type: "text", text: redactCredentials(JSON.stringify(data, null, 2)) }] };
}

function fail(err: unknown): ToolResult {
  const msg = err instanceof Error ? err.message : String(err);
  return { isError: true, content: [{ type: "text", text: `Error: ${redactCredentials(msg)}` }] };
}

function wrap<A>(fn: (args: A) => Promise<unknown>): (args: A) => Promise<ToolResult> {
  return async (args) => {
    try {
      return ok(await fn(args));
    } catch (err) {
      return fail(err);
    }
  };
}

export function createArbServer(service: ArbService): McpServer {
  const server = new McpServer({ name: "arb-mcp", version: "0.0.0" });

  server.registerTool(
    "arb_register",
    {
      description:
        "Join the Agent Reorder Buffer as a new entry. Forks the producer's current fork (or trunk) into a " +
        "local git workspace you can edit. Returns the entryId, workspace path and consumed-symbol hashes. " +
        "Workflow: arb_register -> edit workspace -> arb_push -> arb_ready.",
      inputSchema: registerSchema,
    },
    wrap((a: z.infer<typeof registerSchema>) => service.register(a)),
  );

  server.registerTool(
    "arb_status",
    {
      description:
        "Fetch a buffer entry's status, generation, base/head commits and check summary. When the entry was " +
        "squashed the result includes `instructions` explaining which consumed symbols changed and how to recover (arb_sync).",
      inputSchema: entryIdSchema,
    },
    wrap((a: z.infer<typeof entryIdSchema>) => service.status(a)),
  );

  server.registerTool(
    "arb_sync",
    {
      description:
        "After a squash: wait for the entry's re-fork to land, then replace the workspace with a fresh clone of " +
        "the new producer head. Returns the new base commit and the same squash instructions as arb_status.",
      inputSchema: syncSchema,
    },
    wrap((a: z.infer<typeof syncSchema>) => service.sync(a)),
  );

  server.registerTool(
    "arb_push",
    {
      description:
        "Commit every change in the entry's workspace and push it to the entry's fork. Refused while the entry " +
        "is squashed and not yet synced, so stale-fork work can never be pushed.",
      inputSchema: pushSchema,
    },
    wrap((a: z.infer<typeof pushSchema>) => service.push(a)),
  );

  server.registerTool(
    "arb_ready",
    {
      description:
        "Declare the entry's work done: posts the workspace HEAD commit to the control plane, which runs checks " +
        "and retires the entry in buffer order once they pass.",
      inputSchema: entryIdSchema,
    },
    wrap((a: z.infer<typeof entryIdSchema>) => service.ready(a)),
  );

  server.registerTool(
    "arb_state",
    {
      description:
        "Compact view of the whole reorder buffer: every entry's status/lane/producer, the trunk head and the " +
        "aggregate stats (squashes, early cutoffs, retirements, checks, prediction hits/misses).",
    },
    wrap(() => service.state()),
  );

  return server;
}
