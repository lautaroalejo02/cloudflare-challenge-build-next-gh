export type Lane = string;
export type SymbolHashes = Record<string, string>;

export type EntryStatus =
  | "speculating"
  | "squashed"
  | "ready"
  | "checking"
  | "retired"
  | "failed"
  | "vetoed";

export interface Diagnosis {
  reason: "interface-changed" | "producer-vetoed" | "producer-squashed" | "trunk-overlap" | "prediction-miss"
    | "behavior-changed"; // (V2)
  changed: Array<{
    symbol: string;
    oldHash: string;
    newHash: string;
    oldSignature: string;
    newSignature: string;
  }>;
  producerCommit: string;
  /** (V2) Present only for "behavior-changed". */
  judgment?: { model: string; probability: number };
}

export interface CheckResult {
  commit: string;
  passed: number;
  failed: number;
  durationMs: number;
  results: Array<{ name: string; ok: boolean; error?: string }>;
}

export interface Entry {
  id: string;
  seq: number;
  agent: string;
  lane: Lane;
  status: EntryStatus;
  repo: string;
  remote: string;
  producerId: string | null;
  baseCommit: string;
  headCommit: string | null;
  exports: SymbolHashes;
  consumes: SymbolHashes;
  /** (V2) true when `consumes` was omitted at registration and is inferred. */
  consumesInferred: boolean;
  /** (V2) producer's exports snapshot at the latest (re-)fork. */
  forkedExports: SymbolHashes;
  /** (V2) exported symbol -> bodyHash at headCommit. */
  bodies: SymbolHashes;
  /** (V2) consumed symbols with a pending Jev judgment. */
  judging: string[];
  predicted: string[];
  generation: number;
  diagnosis: Diagnosis | null;
  checks: CheckResult | null;
  /** Sharded control plane (T14): component DO name in aggregated /api/state. */
  component?: string;
}

export interface ArbEvent {
  type: string;
  ts: number;
  entryId?: string;
  data?: Record<string, unknown>;
}

export interface BufferState {
  trunk: { repo: string; commit: string | null; retiredCount: number };
  robSize: number;
  entries: Entry[];
  stats: {
    squashes: number;
    earlyCutoffs: number;
    retired: number;
    checksRun: number;
    pushesSeen: number;
    predictionHits: number;
    predictionMisses: number;
    /** (V2) */
    judgments: number;
    semanticSquashes: number;
    inferredDeps: number;
  };
}

export type Log = (msg: string) => void;
