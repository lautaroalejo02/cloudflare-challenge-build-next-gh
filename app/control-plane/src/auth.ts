// Admin-key authorization for the HTTP surface (T19, review F1).
// Pure decision functions — unit-testable without a Worker runtime.
//
// Policy: every non-GET /api/* request is destructive or mints tokens
// (trunk/init, entries, ready, veto, config, reset), and GET /api/entries/:id
// returns a write token, so all of them require the `x-arb-key` header to
// equal the ARB_ADMIN_KEY Worker secret. Public, read-only surface for the
// dashboard: GET /api/state, GET /api/events, GET /api/ws, plus every non-/api/
// path (static assets).

export const ADMIN_HEADER = "x-arb-key";

/** Does this request need the admin key? */
export function requiresAdminKey(method: string, pathname: string): boolean {
	if (!pathname.startsWith("/api/")) return false;
	if (method !== "GET" && method !== "HEAD") return true;
	// GET /api/entries/:id is the only protected read (it returns a token).
	return /^\/api\/entries\/[^/]+\/?$/.test(pathname);
}

/** Length-independent constant-time string comparison. */
export function keysEqual(a: string, b: string): boolean {
	const ea = new TextEncoder().encode(a);
	const eb = new TextEncoder().encode(b);
	let diff = ea.length ^ eb.length;
	for (let i = 0; i < Math.max(ea.length, eb.length); i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
	return diff === 0;
}

/** 403 Response when the key is missing or wrong, null when authorized. An
 * unset/empty secret keeps protected endpoints CLOSED: a missing secret must
 * never silently open them. */
export function authorize(request: Request, adminKey: string | undefined): Response | null {
	const url = new URL(request.url);
	if (!requiresAdminKey(request.method, url.pathname)) return null;
	const key = request.headers.get(ADMIN_HEADER);
	if (!adminKey || key === null || !keysEqual(key, adminKey)) {
		return new Response(JSON.stringify({ error: "forbidden: missing or invalid x-arb-key" }), {
			status: 403,
			headers: { "content-type": "application/json" },
		});
	}
	return null;
}
