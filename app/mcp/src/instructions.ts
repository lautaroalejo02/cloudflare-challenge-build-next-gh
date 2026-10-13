import type { Diagnosis, DiagnosisReason, Entry } from "./types.ts";

// Human-readable-but-LLM-first explanation of why an entry was squashed,
// rendered per Diagnosis.reason. Returned by arb_status/arb_sync so the agent
// knows what changed and what to do next without reading the wire protocol.
// All server-supplied text is treated as untrusted: single-line fields get
// CR/LF collapsed, signatures are truncated and fenced wider than their own
// backtick runs, and missing values render as "(unknown)".

const REASON_TEXT: Record<DiagnosisReason, string> = {
  "interface-changed":
    "Your producer changed exported signatures that your entry consumes.",
  "producer-vetoed":
    "The human vetoed your producer entry. Your entry was re-forked from the producer's own base (its producer or trunk).",
  "producer-squashed":
    "Your producer was itself squashed and re-forked. Your entry was rebuilt on top of its new head.",
  "trunk-overlap":
    "Your change touched paths that also changed on trunk since your base commit. Path-overlapping work cannot be spliced, so the entry was re-forked.",
  "prediction-miss":
    "The producer's declared interface (stub) did not match its first real push. You forwarded against the predicted hashes, which turned out wrong.",
  "behavior-changed":
    "The producer kept its signatures identical but changed behavior, and the TypeSafe Jev semantic judge decided your usage relies on the old behavior.",
};

const MAX_FIELD = 500;

/** Flatten to one line, truncate, and map missing/blank to `(unknown)`. */
function clean(v: unknown): string {
  const s = typeof v === "string" && v.length ? v : "(unknown)";
  return s.replace(/[\r\n]+/g, " ").slice(0, MAX_FIELD);
}

/** Inline code fenced with one more backtick than the longest run inside the
 * text, so a signature containing backticks cannot break the code span. */
function code(v: unknown): string {
  const s = clean(v);
  let longest = 0;
  for (const m of s.matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
  const fence = "`".repeat(longest + 1);
  return `${fence}${s}${fence}`;
}

function symbolBlock(c: Diagnosis["changed"][number], reason: DiagnosisReason): string {
  if (reason === "behavior-changed") {
    // For behavior-changed oldHash/newHash are bodyHashes and the signatures
    // are equal by construction (the interface did not change).
    return [
      `- ${clean(c.symbol)}: signature unchanged (${code(c.newSignature)}) but its body changed`,
      `  (body hash ${clean(c.oldHash)} -> ${clean(c.newHash)}).`,
    ].join("\n");
  }
  return [
    `- ${clean(c.symbol)}:`,
    `    old: ${code(c.oldSignature)}`,
    `    new: ${code(c.newSignature)}`,
  ].join("\n");
}

export function renderSquashInstructions(entry: Entry): string {
  const d = entry.diagnosis;
  if (!d) {
    return [
      `SQUASHED: entry ${clean(entry.id)} was re-forked but the control plane did not provide a diagnosis.`,
      `Next steps:`,
      `1. Call arb_sync with entryId "${clean(entry.id)}" to replace your workspace with a fresh clone of the new fork.`,
      `2. Redo your changes against the new base, then arb_push and arb_ready as usual.`,
    ].join("\n");
  }
  const lines: string[] = [
    `SQUASHED: entry ${clean(entry.id)} (lane "${clean(entry.lane)}") was re-forked onto producer commit ${clean(d.producerCommit)}.`,
    ``,
    `Why (${clean(d.reason)}):`,
    REASON_TEXT[d.reason] ?? `Reason: ${clean(d.reason)}.`,
  ];
  if (d.changed.length) {
    lines.push(``, `Consumed symbols that changed:`);
    for (const c of d.changed) lines.push(symbolBlock(c, d.reason));
  }
  if (d.reason === "behavior-changed" && d.judgment) {
    const prob =
      typeof d.judgment.probability === "number" && Number.isFinite(d.judgment.probability)
        ? d.judgment.probability.toFixed(2)
        : "(unknown)";
    lines.push(
      ``,
      `Semantic judgment: probability ${prob} (model ${clean(d.judgment.model)})`,
      `that your code relied on the behavior that changed (before body hash -> after body hash`,
      `listed per symbol above).`,
    );
  }
  // For behavior-changed the signatures are identical — there is nothing new
  // "shown above"; the agent must read the new code after syncing instead.
  const redo =
    d.reason === "behavior-changed"
      ? `2. Redo your work against the new base: read the new code in the synced workspace and`
      : `2. Redo your work in the synced workspace against the NEW producer code shown above —`;
  lines.push(
    ``,
    `What to do next:`,
    `1. Call arb_sync with entryId "${clean(entry.id)}". It waits for the re-fork to land and replaces`,
    `   your workspace with a fresh clone of the new producer head.`,
    redo,
    `   do not re-apply your previous diff blindly.`,
    `3. Push with arb_push, then mark done with arb_ready.`,
    ``,
    `Until you call arb_sync, arb_push is refused for this entry so you cannot push work`,
    `based on the stale fork.`,
  );
  return lines.join("\n");
}
