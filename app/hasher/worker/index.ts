import { hashInterface } from "../src/index.ts";

// Throwaway proof Worker (arb-test-hasher). Accepts { files: { path: source } }
// via POST and returns the InterfaceHash JSON.
export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return Response.json({ error: "POST only" }, { status: 405 });
    }
    let body: { files?: Record<string, string> };
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "invalid JSON body" }, { status: 400 });
    }
    if (!body.files || typeof body.files !== "object") {
      return Response.json({ error: "expected { files: { path: source } }" }, { status: 400 });
    }
    const result = await hashInterface(body.files);
    return Response.json(result);
  },
};
