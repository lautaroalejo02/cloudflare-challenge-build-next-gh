import fs from "node:fs";
import path from "node:path";
import { Client } from "../app/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StdioClientTransport } from "../app/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js";
const start = Date.now();
const log = (s) =>
  console.log(`[+${((Date.now() - start) / 1000).toFixed(1)}s] [mcp] ${s}`);
const client = new Client({
  name: "arb-video-scripted-client",
  version: "1.0.0",
});
const serverEnv = { ...process.env };
delete serverEnv.ARB_ADMIN_KEY; // Resolve only the default demo credential file.
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [
    "--experimental-strip-types",
    "--disable-warning=ExperimentalWarning",
    "app/mcp/src/index.ts",
  ],
  env: {
    ...serverEnv,
    ARB_BASE_URL: "https://arb-control-plane.lautitomasalejo.workers.dev",
    ARB_WORKDIR: path.resolve("video/tmp/mcp-work"),
  },
  stderr: "pipe",
});
try {
  await client.connect(transport);
  async function call(name, args) {
    log(`${name} called`);
    const r = await client.callTool({ name, arguments: args });
    if (r.isError) throw new Error("MCP tool failed");
    const data = JSON.parse(r.content.find((x) => x.type === "text").text);
    log(
      `${name} completed${data.status ? " status=" + data.status : ""}${data.commit ? " commit=" + data.commit.slice(0, 8) : ""}`,
    );
    return data;
  }
  const reg = await call("arb_register", {
    agent: "scripted-mcp-video-client",
    lane: "api",
  });
  fs.writeFileSync(
    path.join(reg.workspace, "mcp-demo-note.txt"),
    "Scripted MCP client; live Artifacts fork and retirement.\n",
  );
  const push = await call("arb_push", {
    entryId: reg.entryId,
    message: "chore: demonstrate scripted MCP client",
  });
  const deadline = Date.now() + 90000;
  while (true) {
    const r = await client.callTool({
      name: "arb_status",
      arguments: { entryId: reg.entryId },
    });
    const s = JSON.parse(r.content[0].text);
    if (s.headCommit === push.commit) break;
    if (Date.now() > deadline) throw new Error("push observation timeout");
    await new Promise((r) => setTimeout(r, 1500));
  }
  await call("arb_ready", { entryId: reg.entryId });
  while (true) {
    const r = await client.callTool({
      name: "arb_status",
      arguments: { entryId: reg.entryId },
    });
    const s = JSON.parse(r.content[0].text);
    if (s.status === "retired") {
      log("retired with real checks");
      break;
    }
    if (Date.now() > deadline) throw new Error("retirement timeout");
    await new Promise((r) => setTimeout(r, 1500));
  }
} finally {
  await client.close();
}
