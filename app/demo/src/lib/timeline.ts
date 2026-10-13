import type { Log } from "./types.ts";

export function createTimeline(): (scope: string, msg: string) => void {
  const t0 = Date.now();
  return (scope: string, msg: string) => {
    const t = ((Date.now() - t0) / 1000).toFixed(1).padStart(6);
    process.stdout.write(`[+${t}s] [${scope.padEnd(8)}] ${msg}\n`);
  };
}

export function scoped(tl: (scope: string, msg: string) => void, scope: string): Log {
  return (msg) => tl(scope, msg);
}
