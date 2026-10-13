import type { Diagnosis, DiagnosisReason, Entry } from "./types.ts";

// Human-readable-but-LLM-first explanation of why an entry was squashed,
// rendered per Diagnosis.reason. Returned by arb_status/arb_sync so the agent
// knows what changed and what to do next without reading the wire protocol.

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

function symbolBlock(c: Diagnosis["changed"][number], reason: DiagnosisReason): string {
  if (reason === "behavior-changed") {
    // For behavior-changed oldHash/newHash are bodyHashes and the signatures
    // are equal by construction (the interface did not change).
    return [
      `- ${c.symbol}: signature unchanged (\`${c.newSignature}\`) but its body changed`,
      `  (body hash ${c.oldHash} -> ${c.newHash}).`,
    ].join("\n");
  }
  return [
    `- ${c.symbol}:`,
    `    old: \`${c.oldSignature}\``,
    `    new: \`${c.newSignature}\``,
  ].join("\n");
}

export function renderSquashInstructions(entry: Entry): string {
  const d = entry.diagnosis;
  if (!d) {
    return [
      `SQUASHED: entry ${entry.id} was re-forked but the control plane did not provide a diagnosis.`,
      `Next steps:`,
      `1. Call arb_sync with entryId "${entry.id}" to replace your workspace with a fresh clone of the new fork.`,
      `2. Redo your changes against the new base, then arb_push and arb_ready as usual.`,
    ].join("\n");
  }
  const lines: string[] = [
    `SQUASHED: entry ${entry.id} (lane "${entry.lane}") was re-forked onto producer commit ${d.producerCommit || "unknown"}.`,
    ``,
    `Why (${d.reason}):`,
    REASON_TEXT[d.reason] ?? `Reason: ${d.reason}.`,
  ];
  if (d.changed.length) {
    lines.push(``, `Consumed symbols that changed:`);
    for (const c of d.changed) lines.push(symbolBlock(c, d.reason));
  }
  if (d.reason === "behavior-changed" && d.judgment) {
    lines.push(
      ``,
      `Semantic judgment: probability ${d.judgment.probability.toFixed(2)} (model ${d.judgment.model})`,
      `that your code relied on the behavior that changed (before body hash -> after body hash`,
      `listed per symbol above).`,
    );
  }
  lines.push(
    ``,
    `What to do next:`,
    `1. Call arb_sync with entryId "${entry.id}". It waits for the re-fork to land and replaces`,
    `   your workspace with a fresh clone of the new producer head.`,
    `2. Redo your work in the synced workspace against the NEW producer code shown above —`,
    `   do not re-apply your previous diff blindly.`,
    `3. Push with arb_push, then mark done with arb_ready.`,
    ``,
    `Until you call arb_sync, arb_push is refused for this entry so you cannot push work`,
    `based on the stale fork.`,
  );
  return lines.join("\n");
}
