import type { BufferState, Entry } from "./types.ts";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export class ApiClient {
  base: string;
  constructor(base: string) {
    this.base = base.replace(/\/+$/, "");
  }

  private async req(method: string, path: string, body?: unknown): Promise<any> {
    const r = await fetch(`${this.base}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    let json: any = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = {};
    }
    if (!r.ok) throw new ApiError(r.status, json.error ?? `${method} ${path} -> ${r.status}`);
    return json;
  }

  reset(): Promise<{ ok: boolean }> {
    return this.req("POST", "/api/reset");
  }

  trunkInit(): Promise<{ repo: string; remote: string; token: string }> {
    return this.req("POST", "/api/trunk/init");
  }

  createEntry(body: {
    agent: string;
    lane: string;
    producerId?: string;
    consumes?: string[];
    stub?: Record<string, string>;
  }): Promise<{ entry: Entry; token: string }> {
    return this.req("POST", "/api/entries", body);
  }

  getEntry(id: string): Promise<{ entry: Entry; token?: string }> {
    return this.req("GET", `/api/entries/${id}`);
  }

  ready(id: string, commit: string): Promise<{ entry: Entry }> {
    return this.req("POST", `/api/entries/${id}/ready`, { commit });
  }

  veto(id: string): Promise<{ entry: Entry; squashed: string[] }> {
    return this.req("POST", `/api/entries/${id}/veto`);
  }

  setRobSize(robSize: number): Promise<{ robSize: number }> {
    return this.req("POST", "/api/config", { robSize });
  }

  state(): Promise<BufferState> {
    return this.req("GET", "/api/state");
  }
}
