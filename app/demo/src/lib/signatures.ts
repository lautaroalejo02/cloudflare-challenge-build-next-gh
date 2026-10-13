export type SigVersion = "v1" | "v2";

// Deterministic signature sniffing used by the scripted agents as a stand-in
// for agent intelligence: v2 is the breaking change where createOrder takes an
// options object instead of a bare region string.
export function detectCreateOrderVersion(orderSource: string): SigVersion {
  return /createOrder\s*\(\s*cart\s*:\s*Cart\s*,\s*opts\s*:/.test(orderSource) ? "v2" : "v1";
}
