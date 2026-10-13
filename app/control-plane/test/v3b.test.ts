import { test } from "node:test";
import assert from "node:assert/strict";
import { apply, initialState, rebuildIndexes, type Cmd, type Effect, type RobState } from "../src/rob.ts";
import { realJev, mergeSourceMap } from "../src/ports.ts";
import { judgeBehavior, type JudgeInput } from "../src/jev.ts";
import { execEffects, interfaceToMaps, pushCommand, tokenCache, type EffectHost } from "../src/effects.ts";
import type { Ports, SourceRecord } from "../src/ports.ts";
function run(s: RobState, cmd: Cmd): Effect[] {
    const r = apply(s, cmd, 1000);
    assert.ok(r.ok);
    return r.effects;
}
function world(inferred = false): RobState {
    const s = initialState();
    run(s, { type: "trunk.init", repo: "trunk", remote: "x", commit: "t0" });
    run(s, { type: "entry.create", agent: "p", lane: "p" });
    run(s, { type: "fork.done", entryId: "e1", repo: "p", remote: "x", baseCommit: "p0", exports: { s: "h", other: "h" }, bodies: { s: "b0", other: "x0" }, sigs: { s: { signature: "s()", file: "p.ts" }, other: { signature: "other()", file: "p.ts" } } });
    run(s, { type: "entry.create", agent: "c", lane: "c", producerId: "e1", ...(inferred ? {} : { consumes: ["s"] }) });
    run(s, { type: "fork.done", entryId: "e2", repo: "c", remote: "x", baseCommit: "p0", exports: { s: "h", other: "h" } });
    return s;
}
const push = (s: RobState, commit: string, bodies = { s: "b1", other: "x0" }) => run(s, { type: "push", repo: "p", commit, exports: { s: "h", other: "h" }, bodies });
const verdict = (s: RobState, commit: string) => run(s, { type: "judge.done", producerId: "e1", consumerId: "e2", commit, generation: 0, verdicts: [{ symbol: "s", probability: 0.95 }] });
const events = (eff: Effect[], type: string) => eff.filter(e => e.type === "broadcast" && e.event.type === type);
test("V3b stale judgment keeps the original net-change baseline on an unrelated push", () => {
    const s = world();
    push(s, "A");
    const eff = push(s, "B", { s: "b1", other: "x1" });
    assert.deepEqual(eff.filter(e => e.type === "judge").map(e => e.symbols), [["s"]]);
    assert.equal(s._internal.judgeMarks.e2.s.oldBody, "b0");
    verdict(s, "A");
    assert.deepEqual(s.entries[1].judging, ["s"]);
    verdict(s, "B");
    assert.equal(s.entries[1].diagnosis?.reason, "behavior-changed");
    assert.equal(s.entries[1].diagnosis?.changed[0].oldHash, "b0");
});
test("V3b pending judgments follow pushes even without a new body map", () => {
    const s = world();
    push(s, "A");
    const eff = run(s, { type: "push", repo: "p", commit: "B", exports: { s: "h", other: "h" } });
    assert.ok(eff.some(e => e.type === "judge" && e.commit === "B" && e.symbols.includes("s")));
    verdict(s, "A");
    assert.deepEqual(s.entries[1].judging, ["s"]);
    verdict(s, "B");
    assert.equal(s.entries[1].diagnosis?.reason, "behavior-changed");
});
for (const terminal of ["retired", "vetoed"] as const)
    test(`V3b drops judgment when producer is ${terminal}`, () => {
        const s = world();
        push(s, "A");
        if (terminal === "retired") {
            run(s, { type: "entry.ready", entryId: "e1", commit: "A" });
            run(s, { type: "check.done", entryId: "e1", result: { commit: "A", passed: 1, failed: 0, durationMs: 1, results: [] } });
            run(s, { type: "retire.done", entryId: "e1", commit: "A" });
        }
        else
            run(s, { type: "entry.veto", entryId: "e1" });
        const eff = verdict(s, "A");
        assert.equal(eff.some(e => e.type === "fork" && e.fromRepo === "p"), false);
        assert.deepEqual(s.entries[1].judging, []);
        assert.ok(events(eff, "jev.unavailable").some(e => e.type === "broadcast" && (e.event.data as {
            reason: string;
        }).reason === "producer-not-live"));
    });
test("V3b inference uses the actual in-flight fork content baseline", () => {
    const s = world(true);
    // Reproduce an initial fork still in flight after registration.
    s._internal.pending.e2 = "c";
    run(s, { type: "push", repo: "p", commit: "A", exports: { s: "new", other: "h" } });
    run(s, { type: "fork.done", entryId: "e2", repo: "c", remote: "x", baseCommit: "p0", exports: { s: "h", other: "h" } });
    run(s, { type: "push", repo: "c", commit: "C", exports: {}, imports: [{ file: "c.ts", from: "p.ts", names: ["s"] }] });
    assert.equal(s.entries[1].diagnosis?.reason, "interface-changed");
});
test("V3b untouched trunk exports never imply undeclared ownership", () => {
    const s = initialState();
    run(s, { type: "trunk.init", repo: "trunk", remote: "x", commit: "t0" });
    for (const id of ["e1", "e2"]) {
        run(s, { type: "entry.create", agent: id, lane: id });
        run(s, { type: "fork.done", entryId: id, repo: id, remote: "x", baseCommit: "t0", exports: { inherited: "h" }, bodies: { inherited: "b" }, sigs: { inherited: { signature: "i()", file: "trunk.ts" } } });
    }
    const eff = run(s, { type: "push", repo: "e2", commit: "C", exports: { inherited: "h" }, bodies: { inherited: "b" }, imports: [{ file: "c.ts", from: "trunk.ts", names: ["inherited"] }] });
    assert.equal(events(eff, "deps.undeclared").length, 0);
});
test("V3b undeclared reports exclude untouched names in another entry's changed file", () => {
    const s = world();
    run(s, { type: "entry.create", agent: "other", lane: "other" });
    run(s, { type: "fork.done", entryId: "e3", repo: "other", remote: "x", baseCommit: "t0", exports: { untouched: "h", changed: "h" }, sigs: { untouched: { signature: "u()", file: "shared.ts" }, changed: { signature: "c()", file: "shared.ts" } } });
    run(s, { type: "push", repo: "other", commit: "O", exports: { untouched: "h", changed: "new" } });
    const eff = run(s, { type: "push", repo: "c", commit: "C", exports: {}, imports: [{ file: "c.ts", from: "shared.ts", names: ["untouched"] }] });
    assert.equal(events(eff, "deps.undeclared").length, 0);
});
test("V3b prototype-named exports are inferred as own properties", () => {
    const s = world(true);
    run(s, { type: "push", repo: "p", commit: "A", exports: { constructor: "hc", toString: "ht" }, sigs: { constructor: { signature: "c()", file: "p.ts" }, toString: { signature: "t()", file: "p.ts" } } });
    run(s, { type: "fork.done", entryId: "e2", repo: "c", remote: "x", baseCommit: "A", exports: { constructor: "hc", toString: "ht" } });
    run(s, { type: "push", repo: "c", commit: "C", exports: {}, imports: [{ file: "c.ts", from: "p.ts", names: ["constructor", "toString"] }] });
    assert.deepEqual(Object.keys(s.entries[1].consumes), ["constructor", "toString"]);
});
test("V3b apply hot path preserves stats and never iterates all entries", () => {
    const s = world();
    rebuildIndexes(s);
    const stats = s.stats;
    s.entries = new Proxy(s.entries, { get(target, key, receiver) {
            if (key === Symbol.iterator)
                throw new Error("full entry scan");
            return Reflect.get(target, key, receiver);
        } });
    run(s, { type: "config.set", robSize: 10 });
    assert.equal(s.stats, stats);
});
const input: JudgeInput = { producer: [{ symbol: "s", before: "BEFORE", after: "AFTER", usage: [{ file: "c.ts", code: "USE" }] }], consumer: { agent: "c", lane: "c" } };
test("V3b realJev binds the global fetch receiver", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async function (this: unknown) {
        if (this !== globalThis && this !== undefined)
            throw new TypeError("Illegal invocation");
        return Response.json({ answers: { s0: { noul: 0.2 } } });
    } as typeof fetch;
    try {
        assert.equal((await realJev("fake-key").judge(input))[0].probability, 0.2);
    }
    finally {
        globalThis.fetch = original;
    }
});
test("V3b Jev times out a stalled response body", async () => {
    const result = await Promise.race([judgeBehavior(input, { apiKey: "fake", timeoutMs: 5, sleep: async () => { }, fetch: (async (_url, init) => {
                const stream = new ReadableStream({ start(controller) { init?.signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError"))); } });
                return new Response(stream);
            }) as typeof fetch }), new Promise<null>(resolve => setTimeout(() => resolve(null), 100))]);
    assert.ok(result, "stalled body must resolve within the attempt timeout");
    assert.equal(result[0].reason, "timeout");
});
test("V3b Jev usage occurs once in state and questions reference paths", async () => {
    let body: any;
    await judgeBehavior(input, { apiKey: "fake", fetch: (async (_url, init) => { body = JSON.parse(String(init?.body)); return Response.json({ answers: { s0: { noul: 0.1 } } }); }) as typeof fetch });
    assert.equal(JSON.stringify(body).split('"code":"USE"').length - 1, 1);
    assert.deepEqual(body.questions.s0.instructions.consumer.usage, ["c.ts"]);
});
const record: SourceRecord = { file: "p.ts", bodyHash: "b1", source: "AFTER", commit: "A", prev: { bodyHash: "b0", source: "BEFORE", commit: "p0" } };
function fakeHost(s = world(), files: Record<string, string> = { "c.ts": "USE" }, base: Record<string, string> = {}) {
    const commands: Cmd[] = [];
    let reads = 0;
    const judged: JudgeInput[] = [];
    const h: EffectHost = {
        state: () => s, apply: cmd => { commands.push(cmd); return { ok: true, effects: [] }; }, broadcast: () => { }, registerRepo: () => { }, tokens: tokenCache(async () => "fake"), sleep: async () => { },
        ports: { artifacts: { readTree: async (_repo: string, commit: string) => { reads++; return commit === "p0" ? base : files; }, log: async () => [{ hash: "C" }] } as unknown as Ports["artifacts"],
            hasher: { hashInterface: async () => ({ hash: "h", symbols: [{ name: "s", kind: "function", hash: "h", signature: "s()", file: "p.ts", bodyHash: "b1", source: "x".repeat(5000) }, { name: "unused", kind: "function", hash: "h", signature: "u()", file: "u.ts", bodyHash: "b", source: "UNUSED" }] }), extractImports: async () => Object.keys(files).map(file => ({ file, from: "p.ts", names: file === "unrelated.ts" ? ["other"] : ["s"] })) },
            sources: { get: async () => ({ s: record }), merge: async () => { } }, jev: { judge: async (i) => { judged.push(i); return i.producer.map(p => ({ symbol: p.symbol, probability: 0.1 })); } }, checker: {} as Ports["checker"], retirer: {} as Ports["retirer"] },
    };
    return { h, commands, judged, reads: () => reads };
}
const judge: Effect = { type: "judge", producerId: "e1", consumerId: "e2", symbols: ["s"], commit: "A", generation: 0 };
test("V3b never-pushed consumer has no usage and makes no Jev call", async () => {
    const s = world();
    s.entries[1].headCommit = null;
    const f = fakeHost(s);
    await execEffects(f.h, [judge]);
    assert.equal(f.judged.length, 0);
    assert.equal((f.commands[0] as Extract<Cmd, {
        type: "judge.done";
    }>).verdicts[0].reason, "no-usage");
    assert.equal(f.reads(), 0);
});
test("V3b usage excludes inherited and non-importing files and applies caps", async () => {
    const s = world();
    s.entries[1].headCommit = "C";
    const files = { "inherited.ts": "same", "unrelated.ts": "OTHER", ...Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`c${i}.ts`, "x".repeat(7000)])) };
    const f = fakeHost(s, files, { "inherited.ts": "same" });
    await execEffects(f.h, [judge]);
    const usage = f.judged[0].producer[0].usage;
    assert.equal(usage.length, 4);
    assert.ok(usage.every(u => /^c/.test(u.file) && u.code.length === 6000));
});
test("V3b no key skips all Artifacts and source reads", async () => {
    const f = fakeHost();
    f.h.ports.jev = realJev(undefined);
    await execEffects(f.h, [judge]);
    assert.equal(f.reads(), 0);
    assert.equal((f.commands[0] as Extract<Cmd, {
        type: "judge.done";
    }>).verdicts[0].reason, "no-key");
});
test("V3b source persistence retains only live-consumed bounded declarations", async () => {
    const f = fakeHost();
    let stored: Record<string, any> = {};
    f.h.ports.sources!.merge = async (_id, map) => { stored = map; };
    await pushCommand(f.h, "p", "C");
    assert.deepEqual(Object.keys(stored), ["s"]);
    assert.equal(stored.s.source.length, 4000);
});
test("V3b source storage failures emit one sanitized recover command", async () => {
    const f = fakeHost();
    f.h.ports.sources!.merge = async () => { throw new Error("Bearer secret-token https://private/"); };
    const cmd = await pushCommand(f.h, "p", "C");
    assert.equal(cmd?.type, "push");
    const recover = f.commands.filter(c => c.type === "effect.failed");
    assert.equal(recover.length, 1);
    assert.equal((recover[0] as any).reason, "source-storage-failed");
});
test("V3b source merge replaces symbols no longer consumed", () => {
    assert.deepEqual(mergeSourceMap({ s: record }, {}, "B"), {});
});
test("V3b source merge preserves the original marked declaration across repeated body edits", () => {
    const merged = mergeSourceMap({ s: record }, { s: { file: "p.ts", bodyHash: "b2", source: "LATEST" } }, "B", { s: "b0" });
    assert.equal(merged.s.prev?.source, "BEFORE");
});
test("V3b Jev cancels non-ok response bodies", async () => {
    let cancelled = 0;
    const result = await judgeBehavior(input, { apiKey: "fake", fetch: (async () => new Response(new ReadableStream({ cancel() { cancelled++; } }), { status: 401 })) as typeof fetch });
    assert.equal(result[0].reason, "http-401");
    assert.equal(cancelled, 1);
});
test("V3b source failures broadcast one sanitized recover event", async () => {
    const f = fakeHost();
    const broadcasts: Effect[] = [];
    f.h.apply = cmd => {
        f.commands.push(cmd);
        const r = apply(f.h.state(), cmd);
        assert.ok(r.ok);
        return { ok: true, effects: r.effects };
    };
    f.h.broadcast = event => { broadcasts.push({ type: "broadcast", event }); };
    f.h.ports.sources!.merge = async () => { throw new Error("Bearer private-secret"); };
    await pushCommand(f.h, "p", "C");
    assert.equal(events(broadcasts, "recover").length, 1);
    assert.doesNotMatch(JSON.stringify(broadcasts), /Bearer|private-secret/);
});
test("V3b consumers infer __proto__ as a symbol, not their object prototype", () => {
    const s = world(true);
    const hashes = Object.fromEntries([["__proto__", "hp"]]);
    run(s, { type: "push", repo: "p", commit: "A", exports: hashes, sigs: Object.fromEntries([["__proto__", { signature: "p()", file: "p.ts" }]]) });
    run(s, { type: "fork.done", entryId: "e2", repo: "c", remote: "x", baseCommit: "A", exports: hashes });
    run(s, { type: "push", repo: "c", commit: "C", exports: {}, imports: [{ file: "c.ts", from: "p.ts", names: ["__proto__"] }] });
    assert.ok(Object.hasOwn(s.entries[1].consumes, "__proto__"));
    assert.equal(s.entries[1].consumes.__proto__, "hp");
    assert.equal(Object.getPrototypeOf(s.entries[1].consumes), Object.prototype);
});
test("V3b hasher maps retain prototype-named exports and sources", () => {
    const maps = interfaceToMaps({ hash: "h", symbols: [{ name: "__proto__", kind: "function", hash: "hp", signature: "p()", file: "p.ts", bodyHash: "bp", source: "BODY" }] });
    for (const map of [maps.exports, maps.bodies, maps.sigs, maps.sources])
        assert.ok(Object.hasOwn(map, "__proto__"));
});
test("V3b duplicate export names retain every declaring file for inference", () => {
    const s = world(true);
    const symbols = ["first.ts", "second.ts"].map(file => ({ name: "s", kind: "function" as const, hash: "h", signature: "s()", file, bodyHash: "b", source: "BODY" }));
    const maps = interfaceToMaps({ hash: "h", symbols });
    run(s, { type: "push", repo: "p", commit: "A", exports: maps.exports, sigs: maps.sigs, bodies: maps.bodies });
    run(s, { type: "push", repo: "c", commit: "C", exports: {}, imports: [{ file: "c.ts", from: "first.ts", names: ["s"] }] });
    assert.ok(Object.hasOwn(s.entries[1].consumes, "s"));
    assert.deepEqual(s._internal.files.e1.s, ["first.ts", "second.ts"]);
});
test("V3b retire veto and reset delete entry source records", () => {
    for (const command of ["retire.done", "entry.veto", "reset"] as const) {
        const s = world();
        if (command === "retire.done") {
            run(s, { type: "entry.ready", entryId: "e1", commit: "p0" });
            run(s, { type: "check.done", entryId: "e1", result: { commit: "p0", passed: 1, failed: 0, durationMs: 1, results: [] } });
        }
        const eff = run(s, command === "reset" ? { type: "reset" } : command === "retire.done" ? { type: command, entryId: "e1", commit: "p0" } : { type: command, entryId: "e1" });
        assert.ok(eff.some(e => (e as any).type === "source.delete" && (e as any).entryId === "e1"));
    }
});
test("V3b a declared consumer fork seeds its producer source baseline", async () => {
    const s = world();
    s.entries[0].headCommit = "C";
    const f = fakeHost(s);
    const saved: string[] = [];
    f.h.ports.artifacts.fork = async (_from, name) => ({ name, remote: "x" });
    f.h.ports.sources!.merge = async (id, map) => { if (Object.hasOwn(map, "s"))
        saved.push(id); };
    f.h.apply = cmd => {
        f.commands.push(cmd);
        const r = apply(s, cmd);
        assert.ok(r.ok);
        return { ok: true, effects: r.effects };
    };
    s._internal.pending.e2 = "new-c";
    await execEffects(f.h, [{ type: "fork", entryId: "e2", fromRepo: "p", toRepo: "new-c" }]);
    assert.ok(saved.includes("e1"));
});
test("V3b late terminal producer pushes cannot recreate deleted sources", async () => {
    const s = world();
    s.entries[0].status = "retired";
    const f = fakeHost(s);
    let merges = 0;
    f.h.ports.sources!.merge = async () => { merges++; };
    assert.equal(await pushCommand(f.h, "p", "C"), null);
    assert.equal(merges, 0);
});

async function retainedAfterCleanup(s: RobState, effects: Effect[]): Promise<Record<string, string[]>> {
    const f = fakeHost(s);
    const retained: Record<string, string[]> = {};
    f.h.ports.sources!.retain = async (id, symbols) => { retained[id] = symbols; };
    await execEffects(f.h, effects.filter(e => e.type === "source.prune"));
    return retained;
}

test("V3b interface squash prunes the sole consumer's producer sources", async () => {
    const s = world();
    const eff = run(s, { type: "push", repo: "p", commit: "A", exports: { s: "changed", other: "h" } });
    assert.equal(s.entries[1].status, "squashed");
    assert.deepEqual((await retainedAfterCleanup(s, eff)).e1, []);
});

test("V3b semantic squash prunes the sole consumer's producer sources", async () => {
    const s = world();
    push(s, "A");
    const eff = verdict(s, "A");
    assert.equal(s.entries[1].status, "squashed");
    assert.deepEqual((await retainedAfterCleanup(s, eff)).e1, []);
});

test("V3b squash source pruning preserves other live consumers' symbols", async () => {
    const s = world();
    run(s, { type: "entry.create", agent: "other", lane: "other", producerId: "e1", consumes: ["other"] });
    run(s, { type: "fork.done", entryId: "e3", repo: "other", remote: "x", baseCommit: "p0", exports: { s: "h", other: "h" } });
    const eff = run(s, { type: "push", repo: "p", commit: "A", exports: { s: "changed", other: "h" } });
    assert.equal(s.entries[2].status, "speculating");
    assert.deepEqual((await retainedAfterCleanup(s, eff)).e1, ["other"]);
});

test("V3b veto reparenting prunes sources on the old and new producers", async () => {
    const s = world();
    run(s, { type: "entry.create", agent: "grandchild", lane: "grandchild", producerId: "e2", consumes: ["s"] });
    run(s, { type: "fork.done", entryId: "e3", repo: "grandchild", remote: "x", baseCommit: "p0", exports: { s: "h" } });
    run(s, { type: "entry.ready", entryId: "e1", commit: "p0" });
    run(s, { type: "check.done", entryId: "e1", result: { commit: "p0", passed: 1, failed: 0, durationMs: 1, results: [] } });
    run(s, { type: "retire.done", entryId: "e1", commit: "p0" });
    const eff = run(s, { type: "entry.veto", entryId: "e2" });
    assert.equal(s.entries[2].producerId, "e1");
    const retained = await retainedAfterCleanup(s, eff);
    assert.deepEqual(retained.e2, []);
    assert.deepEqual(retained.e1, []);
});
