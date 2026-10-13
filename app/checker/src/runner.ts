/** Path of the generated entrypoint module inside the Dynamic Worker module map. */
export const RUNNER_MODULE = "__arb_checker__.mjs";

/**
 * Generate the Dynamic Worker entrypoint. It statically imports every test module
 * (dynamic `import()` cannot be resolved against a loader module map) and exposes
 * a default `fetch` that runs each module's `run()` and returns `{ results }`.
 */
export function buildRunnerSource(testModules: string[]): string {
	const imports = testModules
		.map((p, i) => `import * as __m${i} from ${JSON.stringify("./" + p)};`)
		.join("\n");
	const suites = testModules.map((p, i) => `[${JSON.stringify(p)}, __m${i}]`).join(",");
	return `${imports}
const __suites = [${suites}];
export default {
	async fetch() {
		const results = [];
		for (const [__path, __mod] of __suites) {
			if (typeof __mod.run !== "function") {
				results.push({ name: __path, ok: false, error: "module does not export run()" });
				continue;
			}
			try {
				const __rs = await __mod.run();
				if (!Array.isArray(__rs)) {
					results.push({ name: __path, ok: false, error: "run() did not return an array" });
					continue;
				}
				for (const __r of __rs) {
					results.push({
						name: __path + ": " + String((__r && __r.name) ?? "unnamed"),
						ok: !!(__r && __r.ok),
						...(__r && __r.error != null ? { error: String(__r.error) } : {}),
					});
				}
			} catch (__e) {
				results.push({ name: __path, ok: false, error: String((__e && (__e.stack || __e.message)) || __e) });
			}
		}
		return Response.json({ results });
	},
};
`;
}
