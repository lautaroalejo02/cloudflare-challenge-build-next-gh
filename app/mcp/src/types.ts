// Contract types for app/CONTRACTS.md (V2). Defined locally instead of
// importing app/demo/src/lib/types.ts because the demo copy is v1: it lacks
// `behavior-changed`, `judgment`, `consumesInferred`, `judging`, `bodies`.

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

export type DiagnosisReason =
  | "interface-changed"
  | "producer-vetoed"
  | "producer-squashed"
  | "trunk-overlap"
  | "prediction-miss"
  | "behavior-changed";

export interface ChangedSymbol {
  symbol: string;
  oldHash: string;
  newHash: string;
  oldSignature: string;
  newSignature: string;
}

export interface Diagnosis {
  reason: DiagnosisReason;
  changed: ChangedSymbol[];
  producerCommit: string;
  judgment?: { model: string; probability: number };
}

export interface CheckResult {
  commit: string;
  passed: number;
  failed: number;
  durationMs: number;
  results: Array<{ name: string; ok: boolean; error?: string }>;
  infra?: boolean;
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
  consumesInferred?: boolean;
  forkedExports?: SymbolHashes;
  bodies?: SymbolHashes;
  judging?: string[];
  predicted?: string[];
  generation: number;
  diagnosis: Diagnosis | null;
  checks: CheckResult | null;
  component?: string;
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
    judgments?: number;
    semanticSquashes?: number;
    inferredDeps?: number;
  };
}
