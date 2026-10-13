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
  reason: "interface-changed" | "producer-vetoed" | "producer-squashed" | "trunk-overlap" | "prediction-miss";
  changed: Array<{
    symbol: string;
    oldHash: string;
    newHash: string;
    oldSignature: string;
    newSignature: string;
  }>;
  producerCommit: string;
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
  predicted: string[];
  generation: number;
  diagnosis: Diagnosis | null;
  checks: CheckResult | null;
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
  };
}

export type Log = (msg: string) => void;
