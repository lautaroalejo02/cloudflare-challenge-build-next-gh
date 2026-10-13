const REPO = "spike-5b-fixture";
const MAIN = "test/order.test.js";
const COMPAT = "2026-10-12";

async function buildModuleMap(repo) {
	const [commit] = await repo.log({ ref: "main", limit: 1 });
	if (!commit) throw new Error("no commits on main");
	const modules = {};
	let rpcCalls = 0;
	const walk = async (hash, prefix) => {
		const entries = await repo.readTree(hash);
		rpcCalls++;
		for (const e of entries ?? []) {
			const path = prefix + e.name;
			if (e.type === "tree") await walk(e.hash, path + "/");
			else if (e.type === "blob") {
				const blob = await repo.readBlob(e.hash);
				rpcCalls++;
				if (blob) modules[path] = await blob.text();
			}
		}
	};
	await walk(commit.treeHash, "");
	return { modules, commit: commit.hash, rpcCalls };
}

export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		if (url.pathname !== "/run") return new Response("GET /run?mode=get|load", { status: 404 });
		const mode = url.searchParams.get("mode") === "load" ? "load" : "get";
		const t = { mode };

		try {
			let t0 = performance.now();
			using repo = await env.ARTIFACTS.get(REPO);
			t.repoGetMs = +(performance.now() - t0).toFixed(1);

			const toCode = (modules) => ({
				compatibilityDate: COMPAT,
				mainModule: MAIN,
				modules,
				globalOutbound: null,
			});

			let stub;
			if (mode === "load") {
				t0 = performance.now();
				const { modules, commit, rpcCalls } = await buildModuleMap(repo);
				t.commit = commit.slice(0, 8);
				t.mapMs = +(performance.now() - t0).toFixed(1);
				t.moduleCount = Object.keys(modules).length;
				t.rpcCalls = rpcCalls;
				stub = env.LOADER.load(toCode(modules));
			} else {
				// get(): callback does the Artifacts reads only on cold load
				t0 = performance.now();
				const [commit] = await repo.log({ ref: "main", limit: 1 });
				const id = `spike-5b:${commit.hash}`;
				stub = env.LOADER.get(id, async () => {
					t.callbackRan = true;
					const built = await buildModuleMap(repo);
					t.mapMs = +(performance.now() - t0).toFixed(1);
					t.moduleCount = Object.keys(built.modules).length;
					t.rpcCalls = built.rpcCalls;
					return toCode(built.modules);
				});
				t.commit = commit.hash.slice(0, 8);
				t.callbackRan = t.callbackRan ?? false;
			}

			const ep = stub.getEntrypoint();
			t0 = performance.now();
			const res1 = await ep.fetch("https://dynamic/run");
			t.firstFetchMs = +(performance.now() - t0).toFixed(1);
			t0 = performance.now();
			const res2 = await ep.fetch("https://dynamic/run");
			t.secondFetchMs = +(performance.now() - t0).toFixed(1);
			t.test = await res2.json();
			await res1.arrayBuffer(); // drain
			return Response.json(t);
		} catch (err) {
			t.error = String(err && (err.stack || err.message || err));
			return Response.json(t, { status: 500 });
		}
	},
};
