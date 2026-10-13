export type SigVersion = "v1" | "v2";

// Deterministic signature sniffing used by the scripted agents as a stand-in
// for agent intelligence: v2 is the breaking change where createOrder takes an
// options object instead of a bare region string.
export function detectCreateOrderVersion(orderSource: string): SigVersion {
  return /createOrder\s*\(\s*cart\s*:\s*Cart\s*,\s*opts\s*:/.test(orderSource) ? "v2" : "v1";
}

// (V2) Behavior sniffing for the same-signature beat: the producer's
// createOrder now adds 20% VAT to totals (`* 1.2`). Consumers redo their work
// against whatever behavior the freshly cloned fork carries.
export function detectVat(orderSource: string): boolean {
  return /\*\s*1\.2\b/.test(orderSource);
}
