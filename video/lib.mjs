export function scrub(s) {
  return String(s)
    .replace(/art_v\d+_[A-Za-z0-9._~-]+/g, "[redacted]")
    .replace(/Bearer\s+\S+/gi, "[authorization redacted]")
    .replace(/([?&])key=[^\s&#]+/gi, "[query redacted]")
    .replace(/\.secret-admin-key/g, "[credential file]")
    .replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/g, "https://[redacted]@");
}
export function buildMode(args) {
  if (args.length === 0) return "capture";
  const modes = new Map([
    ["--help", "help"],
    ["--render-only", "render"],
    ["--cues-only", "cues"],
  ]);
  if (args.length !== 1 || !modes.has(args[0]))
    throw new Error("Unsupported video build option; use --help.");
  return modes.get(args[0]);
}
export function parseTimeline(s) {
  return s.split("\n").flatMap((line) => {
    const m = /\[\+\s*([\d.]+)s\]\s*\[([^\]]+)\]\s*(.*)/.exec(line);
    return m ? [{ time: Number(m[1]), scope: m[2].trim(), text: m[3] }] : [];
  });
}
export const stamp = (s) =>
  `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
export function mainCaptions(rows, offset = 0) {
  const c = [
    {
      start: 0,
      end: 6,
      text: "Agents are scripted · forks, hashing, Jev, tests and retirement are real",
    },
  ];
  const add = (r, text, duration = 6) => {
    if (r)
      c.push({ start: offset + r.time, end: offset + r.time + duration, text });
  };
  add(
    rows.find((r) => r.scope === "ui" && r.text.startsWith("registered ")) ??
      rows.find((r) => r.text.includes("ui registers WITHOUT consumes")),
    "Stub prediction: UI starts before the API exists",
  );
  for (const verdict of ["clear", "squash"]) {
    const refactor = rows.find(
      (r) =>
        r.scope === "api" && r.text.includes("reimplement sumCart with reduce"),
    );
    const commit = refactor ? /pushed (\w+)/.exec(refactor.text)?.[1] : null;
    const r = rows.find(
      (r) =>
        r.scope === "v2" &&
        r.text.includes("jev.judged") &&
        r.text.includes(`verdict=${verdict}`) &&
        !(verdict === "clear" && commit && !r.text.includes(commit)),
    );
    if (r) {
      const judgedCommit = /commit (\w+)/.exec(r.text)?.[1];
      const judgments = rows.filter(
        (row) =>
          row.scope === "v2" &&
          row.text.includes("jev.judged") &&
          row.text.includes(`verdict=${verdict}`) &&
          (judgedCommit ? row.text.includes(judgedCommit) : row === r),
      );
      const p = [
        ...new Set(judgments.map((row) => /p=([\d.]+)/.exec(row.text)[1])),
      ].join("/");
      add(
        { ...r, time: Math.max(...judgments.map((row) => row.time)) },
        verdict === "clear"
          ? `Body-only refactor → early cutoff (Jev p=${p})`
          : `Same signature, behavior changed → Jev p=${p} → SQUASH`,
      );
    }
  }
  const breaking = rows.find(
    (r) => r.scope === "api" && r.text.includes('"feat(api)!:'),
  );
  const squash = breaking
    ? rows.find(
        (r) =>
          r.scope === "buffer" &&
          r.time >= breaking.time &&
          r.text.includes("-> squashed"),
      )
    : null;
  add(
    squash ??
      rows.find((r) => {
        if (!r.text.includes("squashed: createOrder")) return false;
        const signatures = r.text
          .split("squashed: createOrder ")[1]
          .split(" -> ");
        return signatures.length === 2 && signatures[0] !== signatures[1];
      }),
    "Signature changed → SQUASH + re-fork",
  );
  add(
    rows.find((r) => r.text.includes("all three entries retired")),
    "Retired in order onto trunk",
    4,
  );
  return c;
}
