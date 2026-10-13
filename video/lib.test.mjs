import test from "node:test";
import assert from "node:assert/strict";
import {
  parseTimeline,
  mainCaptions,
  scrub,
  stamp,
  buildMode,
} from "./lib.mjs";
test("timeline offset and speed map the actual judgment, not final summary", () => {
  const rows = parseTimeline(
    "[+ 12.3s] [v2      ] jev.judged e2 createOrder p=0.02 verdict=clear\n[+ 28.1s] [v2 ] jev.judged e2 createOrder p=0.94 verdict=squash\n[+ 91.0s] [final ] jev.judged e2 createOrder p=0.94 verdict=squash",
  );
  assert.equal(rows.length, 3);
  const c = mainCaptions(rows, 2);
  assert.equal(c.find((x) => x.text.includes("0.94")).start, 30.1);
  assert.equal(c.find((x) => x.text.includes("0.02")).start, 14.3);
});
test("scrubs credential prefixes, authorization and query material", () => {
  const s = scrub(
    "art_v2_fakeSecret Bearer abc ?key=abc .secret-admin-key https://x:token@host",
  );
  assert.doesNotMatch(s, /art_v2_|Bearer|\?key=|\.secret-admin-key|token/);
});
test("cue clock is stable", () => assert.equal(stamp(95.2), "01:35"));
test("refactor caption binds the reduce commit, not an earlier clear judgment", () => {
  const rows = parseTimeline(
    '[+ 2.0s] [v2] jev.judged e2 createOrder p=0.23 verdict=clear (commit aaaaaaaa)\n[+ 4.0s] [api] pushed bbbbbbbb "refactor(api): reimplement sumCart with reduce"\n[+ 6.0s] [v2] jev.judged e2 createOrder p=0.02 verdict=clear (commit bbbbbbbb)',
  );
  assert.equal(
    mainCaptions(rows).find((c) => c.text.includes("early cutoff")).start,
    6,
  );
});
test("signature caption ignores a semantic squash with unchanged signature", () => {
  const rows = parseTimeline(
    "[+ 20s] [ui] squashed: createOrder fn createOrder(cart:Cart,region:string):Order -> fn createOrder(cart:Cart,region:string):Order\n[+ 40s] [ui] squashed: createOrder fn createOrder(cart:Cart,region:string):Order -> fn createOrder(cart:Cart,opts:{region:string currency:string}):Order",
  );
  assert.equal(
    mainCaptions(rows).find((c) => c.text.startsWith("Signature changed"))
      .start,
    40,
  );
});
test("semantic caption includes both real consumer probabilities on the same commit", () => {
  const rows = parseTimeline(
    "[+ 40s] [v2] jev.judged e2 createOrder p=0.94 verdict=squash (commit abcdef12)\n[+ 40s] [v2] jev.judged e3 createOrder p=0.97 verdict=squash (commit abcdef12)",
  );
  assert.match(
    mainCaptions(rows).find((c) => c.text.includes("behavior changed")).text,
    /p=0.94\/0.97/,
  );
});
test("signature caption uses the observed squash transition, not later clone diagnosis", () => {
  const rows = parseTimeline(
    '[+ 30s] [api] pushed 12345678 "feat(api)!: createOrder now takes options"\n[+ 30.8s] [buffer] e2 (ui) ready -> squashed\n[+ 36s] [ui] squashed: createOrder old -> new',
  );
  assert.equal(
    mainCaptions(rows).find((c) => c.text.startsWith("Signature changed"))
      .start,
    30.8,
  );
});
test("only an explicit default invocation can start live capture", () => {
  assert.equal(buildMode([]), "capture");
  assert.equal(buildMode(["--help"]), "help");
  assert.equal(buildMode(["--render-only"]), "render");
  assert.equal(buildMode(["--cues-only"]), "cues");
  assert.throws(() => buildMode(["--render-onyl"]));
  assert.throws(() => buildMode(["__proto__"]));
  assert.throws(() => buildMode(["--cues-only", "--render-only"]));
});
