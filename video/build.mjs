import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { chromium } from "../app/dashboard/node_modules/playwright/index.mjs";
import {
  scrub,
  parseTimeline,
  mainCaptions,
  stamp,
  buildMode,
} from "./lib.mjs";
const mode = buildMode(process.argv.slice(2));
if (mode === "help") {
  console.log(
    "Usage: node video/build.mjs [--render-only | --cues-only | --help]\nDefault: capture four live scenarios sequentially, then render. Other modes are local-only.",
  );
  process.exit(0);
}
const root = path.resolve(import.meta.dirname, ".."),
  tmp = path.join(root, "video/tmp"),
  out = path.join(root, "video/out");
const BASE = "https://arb-control-plane.lautitomasalejo.workers.dev";
const captureEnv = { ...process.env };
delete captureEnv.ARB_ADMIN_KEY; // Use the scenario's default credential file only.
fs.mkdirSync(tmp, { recursive: true });
fs.mkdirSync(out, { recursive: true });
const save = (name, data) =>
  fs.writeFileSync(
    path.join(tmp, name),
    typeof data === "string" ? data : JSON.stringify(data, null, 2),
  );
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function exec(command, args, cwd = root, env = process.env) {
  return new Promise((resolve, reject) => {
    let text = "";
    const c = spawn(command, args, {
      cwd,
      env,
      shell: process.platform === "win32" && command.endsWith(".cmd"),
    });
    c.stdout.on("data", (d) => (text += d));
    c.stderr.on("data", (d) => (text += d));
    c.on("error", reject);
    c.on("close", (code) => resolve({ code, text: scrub(text) }));
  });
}
async function ff(args, label) {
  const r = await exec(
    "ffmpeg",
    ["-hide_banner", "-loglevel", "error", "-y", ...args],
    tmp,
  );
  save(`${label}.log`, r.text);
  if (r.code !== 0)
    throw new Error(`ffmpeg ${label} failed (see scrubbed log)`);
}
async function probe(file) {
  const r = await exec("ffprobe", [
    "-v",
    "error",
    "-show_format",
    "-show_streams",
    "-of",
    "json",
    file,
  ]);
  if (r.code) throw new Error("ffprobe failed");
  return JSON.parse(r.text);
}
async function capture(name, browser) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const dir = path.join(tmp, `${name}-take-${attempt}`);
    fs.mkdirSync(dir, { recursive: true });
    const ctx = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      recordVideo: { dir, size: { width: 1920, height: 1080 } },
    });
    const recStart = Date.now(),
      page = await ctx.newPage();
    let result, offset;
    try {
      await page.goto(BASE, { waitUntil: "domcontentloaded" });
      await page.waitForSelector(".dot.ws, .dot.poll", { timeout: 120000 });
      if (
        new URL(page.url()).search ||
        (await page.locator('input[type="range"]').count())
      )
        throw new Error("Public dashboard safety check failed");
      await wait(1500);
      offset = (Date.now() - recStart) / 1000;
      result =
        name === "mcp"
          ? await exec(
              process.execPath,
              ["video/mcp-scene.mjs"],
              root,
              captureEnv,
            )
          : await exec(
              process.platform === "win32" ? "npm.cmd" : "npm",
              [
                "run",
                "demo",
                "--",
                "--base",
                BASE,
                ...(name === "main" ? [] : ["--scenario", name]),
              ],
              path.join(root, "app/demo"),
              captureEnv,
            );
      save(`${name}-take-${attempt}.log`, result.text);
      await wait(
        Math.max(4000, name === "mcp" ? 40000 - (Date.now() - recStart) : 0),
      );
      const events = await page.request.get(`${BASE}/api/events`);
      save(`${name}-take-${attempt}.events.json`, scrub(await events.text()));
    } finally {
      await ctx.close();
    }
    const file = path.join(tmp, `${name}-take-${attempt}.webm`);
    await page.video().saveAs(file);
    if (!result) throw new Error(`capture ${name} interrupted`);
    console.log(`${name} attempt ${attempt}: exit ${result.code}`);
    if (result.code === 0) {
      const info = await probe(file);
      return {
        name,
        file,
        attempt,
        code: 0,
        offset,
        recStart,
        duration: Number(info.format.duration),
        rows: parseTimeline(result.text),
      };
    }
    if (attempt === 2)
      throw new Error(`${name} failed twice; no subsequent scenarios recorded`);
  }
}
const enc = [
  "-an",
  "-c:v",
  "libx264",
  "-preset",
  "fast",
  "-crf",
  "20",
  "-pix_fmt",
  "yuv420p",
  "-r",
  "30",
  "-threads",
  "4",
];
const font = "fontfile='C\\:/Windows/Fonts/consola.ttf'";
async function renderLive(take, speed, captions, label) {
  const filters = [
    `setpts=(PTS-STARTPTS)/${speed}`,
    "fps=30",
    "scale=1920:1080",
  ];
  if (speed !== 1) {
    save(`${label}-speed.txt`, "1.5×");
    filters.push(
      `drawtext=${font}:textfile=${label}-speed.txt:x=w-tw-40:y=32:fontsize=34:fontcolor=white:box=1:boxcolor=0x111315@0.9:boxborderw=15`,
    );
  }
  for (let i = 0; i < captions.length; i++) {
    const c = captions[i];
    save(`${label}-caption-${i}.txt`, c.text);
    const placement =
      c.position === "top"
        ? "x=40:y=110:fontsize=25"
        : c.position === "upper-lower"
          ? "x=(w-tw)/2:y=h-175:fontsize=32"
          : "x=(w-tw)/2:y=h-100:fontsize=32";
    filters.push(
      `drawtext=${font}:textfile=${label}-caption-${i}.txt:${placement}:fontcolor=white:box=1:boxcolor=0x111315@0.95:boxborderw=20:enable='between(t,${c.start / speed},${c.end / speed})'`,
    );
  }
  const file = path.join(tmp, `${label}.mp4`);
  await ff(["-i", take.file, "-vf", filters.join(","), ...enc, file], label);
  return {
    name: label,
    file,
    duration: Number((await probe(file)).format.duration),
    captions: captions.map((c) => ({
      ...c,
      start: c.start / speed,
      end: c.end / speed,
    })),
  };
}
const cards = {
  title: {
    title: "Agent Reorder Buffer",
    lines: ["Out-of-order execution for coding agents"],
    footer:
      "Built on Cloudflare Artifacts · Durable Objects · Dynamic Workers · Queues",
  },
  problem: {
    title: "Integration starts too late",
    lines: [
      "Merge queues speculate CI over finished PRs.",
      "ARB forwards unfinished work at dispatch time.",
    ],
    footer:
      "Sources: README.md · research/top10.md, Idea 3 · https://graphite.com/docs/graphite-merge-queue",
  },
  mechanism: {
    title: "Four mechanisms. One buffer.",
    lines: [
      "Forwarding — consumers start on the producer’s unfinished fork",
      "Squash on interface change",
      "Jev semantic squash on same-signature behavior change",
      "In-order retirement — Dynamic Worker tests; fast-forward or path-disjoint splice",
    ],
    footer: "Implementation: README.md · app/CONTRACTS.md",
  },
  numbers: {
    title: "Measured, not simulated",
    lines: [
      "Jev: 0.02 clear vs 0.93–0.97 squash",
      "Live validation: main, failing-check and multi exit 0",
      "Earlier live re-forks: 2.3 / 4.5 s (two parallel forks)",
      "Earlier retirement: fast-forward 507 / 518 ms · splice 1085 ms",
      "Same machine, N = 100,000: v1 10.3 µs vs v2 19.1 µs median",
      "p95: 78.3 µs vs 79.7 µs · synthetic state machine, not network latency",
    ],
    footer:
      "Sources: README.md measured tables · odd/tasks/arb-v2.md (V3b, V4, V8)",
  },
  closing: {
    title: "Agent Reorder Buffer",
    lines: [
      "https://github.com/lautaroalejo02/cloudflare-challenge-build-next-gh",
    ],
    footer: "Scripted agents. Real Cloudflare execution. Your narration.",
  },
};
async function renderCard(browser, name, duration) {
  const card = cards[name],
    page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  const html = `<!doctype html><meta charset="utf-8"><style>*{box-sizing:border-box}body{margin:0;background:#111315;color:#edf0f2;font-family:'Segoe UI',sans-serif;width:1920px;height:1080px;padding:105px 115px;display:flex;flex-direction:column;border-top:12px solid #87b3cc}.eyebrow{font:25px Consolas;color:#87b3cc;letter-spacing:4px}h1{font-size:78px;line-height:1.15;margin:75px 0 48px;font-weight:600}.line{font:30px/1.5 Consolas;margin:14px 0;color:#edf0f2}.footer{margin-top:auto;font:22px/1.5 Consolas;color:#a5acb3;border-top:1px solid #3a4046;padding-top:28px}</style><div class="eyebrow">ARB / LIVE SYSTEM DEMO</div><h1>${card.title}</h1>${card.lines.map((l) => `<div class="line">${l}</div>`).join("")}<div class="footer">${card.footer}</div>`;
  save(`${name}.html`, html);
  await page.setContent(html);
  await page.screenshot({ path: path.join(tmp, `${name}.png`) });
  await page.close();
  const file = path.join(tmp, `${name}.mp4`);
  await ff(
    [
      "-loop",
      "1",
      "-framerate",
      "30",
      "-i",
      `${name}.png`,
      "-t",
      String(duration),
      ...enc,
      file,
    ],
    name,
  );
  return { name, file, duration };
}
async function pipeline() {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  try {
    const takes = [];
    if (mode === "render") {
      for (const t of JSON.parse(
        fs.readFileSync(path.join(tmp, "live-evidence.json"), "utf8"),
      ))
        takes.push({
          ...t,
          file: path.join(tmp, `${t.name}-take-${t.attempt}.webm`),
          rows: parseTimeline(
            fs.readFileSync(
              path.join(tmp, `${t.name}-take-${t.attempt}.log`),
              "utf8",
            ),
          ),
        });
    } else
      for (const name of ["main", "failing-check", "multi", "mcp"])
        takes.push(await capture(name, browser));
    save(
      "live-evidence.json",
      takes.map(({ file, rows, ...t }) => ({
        ...t,
        judgments: rows.filter(
          (r) => r.scope === "v2" && r.text.includes("jev.judged"),
        ),
      })),
    );
    const [main, fail, multi, mcp] = takes;
    const mc = mainCaptions(main.rows, main.offset);
    if (mc.length !== 6)
      throw new Error("Missing required live main evidence for captions");
    const failed = fail.rows.find((r) =>
        /-> failed|check.*fail|failed check/i.test(r.text),
      ),
      fix = fail.rows.find(
        (r) => /fix|correct|repair/i.test(r.text) && r.scope !== "scenario",
      );
    if (!failed || !fix)
      throw new Error("Missing failed-check or fix timeline evidence");
    const live = [
      await renderLive(main, 1, mc, "main"),
      await renderLive(
        fail,
        1.5,
        [
          {
            start: failed.time + fail.offset,
            end: failed.time + fail.offset + 9,
            text: "Real Dynamic Worker check failed → retirement blocked",
            position: "upper-lower",
          },
          {
            start: fix.time + fail.offset,
            end: fix.time + fail.offset + 9,
            text: "Scripted agent fixes the test → real checks run again",
          },
        ],
        "failing-check",
      ),
      await renderLive(
        multi,
        1.5,
        [
          {
            start:
              multi.offset +
              multi.rows.find(
                (r) => r.scope === "p-ui" && r.text.includes("retired seq="),
              ).time,
            end:
              multi.offset +
              multi.rows.find(
                (r) => r.scope === "p-ui" && r.text.includes("retired seq="),
              ).time +
              12,
            text: "Two independent chains · no head-of-line blocking",
          },
        ],
        "multi",
      ),
      await renderLive(
        mcp,
        1,
        [
          {
            start: 0,
            end: 40,
            text: "Any MCP agent can join: arb_register → arb_push → arb_ready (scripted MCP client shown)",
          },
          {
            start:
              mcp.offset +
              mcp.rows.filter((r) => r.text.includes("completed")).at(-1).time,
            end: mcp.duration,
            position: "top",
            text:
              "Actual scripted MCP client log:\n" +
              mcp.rows
                .filter((r) => r.text.includes("completed"))
                .map((r) => r.text)
                .join("\n"),
          },
        ],
        "mcp",
      ),
    ];
    const liveDuration = live.reduce((s, x) => s + x.duration, 0),
      extra = Math.max(0, 360 - (liveDuration + 101));
    const scenes = [
      await renderCard(browser, "title", 8),
      await renderCard(browser, "problem", 25),
      await renderCard(browser, "mechanism", 30 + extra),
      ...live,
      await renderCard(browser, "numbers", 30),
      await renderCard(browser, "closing", 8),
    ];
    let time = 0;
    for (const scene of scenes) {
      scene.start = time;
      time += scene.duration;
    }
    if (time < 300 || time > 420)
      throw new Error(`Runtime ${time}s outside 5–7 minutes`);
    save(
      "concat.txt",
      scenes.map((s) => `file '${s.file.replaceAll("\\", "/")}'`).join("\n"),
    );
    await ff(
      [
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        "concat.txt",
        "-vf",
        "fps=30",
        ...enc,
        "-movflags",
        "+faststart",
        path.join(out, "arb-demo-1080p.mp4"),
      ],
      "final",
    );
    save("segments.json", scenes);
    const finalProbe = await probe(path.join(out, "arb-demo-1080p.mp4"));
    const stream = finalProbe.streams.find((s) => s.codec_type === "video");
    if (
      !stream ||
      stream.codec_name !== "h264" ||
      stream.width !== 1920 ||
      stream.height !== 1080 ||
      stream.avg_frame_rate !== "30/1" ||
      finalProbe.streams.some((s) => s.codec_type === "audio") ||
      Number(finalProbe.format.duration) < 300 ||
      Number(finalProbe.format.duration) > 420
    ) {
      throw new Error(
        "Final ffprobe verification does not match the delivery contract",
      );
    }
    fs.writeFileSync(
      path.join(out, "verification.json"),
      JSON.stringify(
        {
          probe: finalProbe,
          scenes: scenes.map(({ file, captions, ...x }) => x),
          live: takes.map(({ file, rows, ...x }) => ({
            ...x,
            judgments: rows.filter(
              (r) => r.scope === "v2" && r.text.includes("jev.judged"),
            ),
          })),
        },
        null,
        2,
      ),
    );
    const frames = path.join(out, "frames");
    fs.mkdirSync(frames, { recursive: true });
    for (let i = 0; i < scenes.length; i++) {
      const s = scenes[i];
      const moment =
        s.name === "main"
          ? s.captions.find((c) => c.text.includes("behavior changed")).start +
            2
          : s.name === "failing-check"
            ? s.captions[0].start + 0.6
            : s.name === "multi"
              ? s.captions[0].start + 1
              : s.duration / 2;
      await ff(
        [
          "-ss",
          String(s.start + moment),
          "-i",
          path.join(out, "arb-demo-1080p.mp4"),
          "-frames:v",
          "1",
          path.join(frames, `${String(i + 1).padStart(2, "0")}-${s.name}.png`),
        ],
        `frame-${i + 1}`,
      );
    }
    writeCues(scenes);
    const logs = fs
      .readdirSync(tmp)
      .filter((n) => n.endsWith(".log"))
      .map((n) => fs.readFileSync(path.join(tmp, n), "utf8"));
    const secrets = /art_v2_|Bearer|\.secret-admin-key|\?key=/;
    if (
      [...logs, fs.readFileSync(path.join(root, "video/cues.md"), "utf8")].some(
        (s) => secrets.test(s),
      )
    )
      throw new Error("Secret marker scan failed");
    console.log(
      `Final duration: ${time.toFixed(2)}s; nine representative frames; saved logs/cues marker scan clean`,
    );
  } finally {
    await browser.close();
  }
}
function writeCues(scenes) {
  const sayProbability = (text) => {
    const digits = [
      "zero",
      "one",
      "two",
      "three",
      "four",
      "five",
      "six",
      "seven",
      "eight",
      "nine",
    ];
    return /p=([\d./]+)/
      .exec(text)?.[1]
      .split("/")
      .map((p) =>
        p
          .split("")
          .map((ch) => (ch === "." ? "point" : digits[Number(ch)]))
          .join(" "),
      )
      .join(" and ");
  };
  const narrateBeat = (text) => {
    if (text.startsWith("Two independent"))
      return "Payments retire while orders are still running. This later-sequence consumer did not wait for the other component’s head.";
    if (text.startsWith("Stub prediction"))
      return "The UI starts before the API implementation exists, using a predicted interface.";
    if (text.startsWith("Body-only"))
      return `Jev scores this refactor ${sayProbability(text)}. Consumers keep their work.`;
    if (text.startsWith("Same signature"))
      return `The signature stayed the same, but behavior changed. Jev scores ${sayProbability(text)}; both consumers are squashed.`;
    if (text.startsWith("Signature changed"))
      return "Now the signature changes. Consumers are squashed and re-forked from the new producer head.";
    return "All three entries have now retired in dependency order.";
  };
  const narration = {
    title:
      "This is Agent Reorder Buffer: out-of-order execution for coding agents, built on Cloudflare.",
    problem:
      "Merge queues speculate over finished pull requests. This project moves coordination earlier: consumers can begin while their producer is still working.",
    mechanism:
      "Forward the producer’s unfinished fork. Squash consumers when an interface changes. Use Jev to judge same-signature behavior changes. Then run tests in Dynamic Workers and retire in dependency order, by fast-forward or path-disjoint splice. There is no textual merge.",
    main: "This is the live public dashboard at normal speed. The agents are scripted; forks, hashing, semantic judgments, tests and retirement are real.",
    "failing-check":
      "This second live run is shown at one and a half times speed. A real failing test prevents retirement. Watch the scripted agent fix its assertion, then the checks run again.",
    multi:
      "Two independent chains now share the same trunk. Each component makes progress without waiting for the other component’s head. Retirement onto trunk is still serialized.",
    mcp: "This scene uses the actual stdio MCP server and a scripted MCP client. Register creates a real fork and local workspace. Push sends a real commit. Ready runs real checks before the entry retires. No tool output is invented.",
    numbers:
      "Earlier runs re-forked in two point three to four point five seconds. Retirement was roughly half a second by fast-forward, or one point one seconds by splice. Jev scores point zero two versus point nine three to point nine seven. The synthetic, same-machine state-machine benchmark shows a higher version two median, with the ninety-fifth percentile almost flat.",
    closing:
      "The code, evidence and rebuild instructions are in this repository.",
  };
  const cues = scenes
    .flatMap((s) => [
      {
        start: s.start,
        segment: s.name,
        screen:
          s.name in cards
            ? s.name === "closing"
              ? "Repository URL: " + cards.closing.lines[0]
              : cards[s.name].title + " — HTML card"
            : "Live public dashboard" +
              (["multi", "failing-check"].includes(s.name) ? " · 1.5×" : ""),
        line: narration[s.name],
      },
      ...(["main", "failing-check", "multi"].includes(s.name)
        ? (s.name === "failing-check" ? s.captions.slice(0, 1) : s.captions)
            .filter((c) => c.start > 0)
            .map((c) => ({
              start: s.start + c.start,
              segment: `${s.name} beat`,
              screen:
                s.name === "failing-check"
                  ? `Check fails; scripted fix begins ${(s.captions[1].start - c.start).toFixed(1)} seconds later`
                  : c.text,
              line:
                s.name === "failing-check"
                  ? "A real check fails. The agent immediately fixes it, and real checks run again."
                  : narrateBeat(c.text),
            }))
        : []),
    ])
    .sort((a, b) => a.start - b.start);
  fs.writeFileSync(
    path.join(root, "video/cues.md"),
    "# Narration cue sheet\n\nSilent 1080p demo. Read calmly; leave pauses between cues. Timings below come from this capture, not an illustrative replay.\n\n| Start | Segment | On screen | Suggested narration |\n|---|---|---|---|\n" +
      cues
        .map(
          (c) =>
            `| ${stamp(c.start)} | ${c.segment} | ${c.screen} | ${c.line} |`,
        )
        .join("\n") +
      "\n\n## Add your voice track\n\n```sh\nffmpeg -i video/out/arb-demo-1080p.mp4 -i voice.m4a -c:v copy -c:a aac -shortest video/out/arb-demo-final.mp4\n```\n",
  );
}
if (mode === "cues") {
  writeCues(
    JSON.parse(fs.readFileSync(path.join(tmp, "segments.json"), "utf8")),
  );
} else
  await pipeline().catch((e) => {
    save("failure.log", scrub(e.stack));
    console.error(scrub(e.message));
    process.exitCode = 1;
  });
