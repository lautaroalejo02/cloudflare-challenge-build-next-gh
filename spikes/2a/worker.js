export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/time") {
      return Response.json({ now: Date.now() });
    }
    if (url.pathname === "/dump") {
      const list = await env.EVENTS.list();
      const out = {};
      for (const k of list.keys) {
        out[k.name] = JSON.parse(await env.EVENTS.get(k.name));
      }
      return Response.json(out);
    }
    return new Response("ok");
  },
  async queue(batch, env) {
    for (const msg of batch.messages) {
      const receivedAt = Date.now();
      const ev = msg.body;
      const key = `${ev?.payload?.after ?? "unknown"}-${receivedAt}`;
      await env.EVENTS.put(key, JSON.stringify({ received_at: receivedAt, event: ev }));
      msg.ack();
    }
  },
};
