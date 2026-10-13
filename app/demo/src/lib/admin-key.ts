import fs from "node:fs";
import path from "node:path";

/** Default key file: written once at deploy time, gitignored by the root
 * `.secret*` rule (T19). Never log its contents. */
export const DEFAULT_ADMIN_KEY_FILE = path.resolve(import.meta.dirname, "../../../control-plane/.secret-admin-key");

/** Admin key for the control plane's protected endpoints: the
 * `ARB_ADMIN_KEY` env var, else the key file, else undefined (the local mock
 * does not require one). */
export function resolveAdminKey(
  env: Record<string, string | undefined> = process.env,
  file: string = DEFAULT_ADMIN_KEY_FILE,
): string | undefined {
  const fromEnv = env.ARB_ADMIN_KEY?.trim();
  if (fromEnv) return fromEnv;
  try {
    const fromFile = fs.readFileSync(file, "utf8").trim();
    return fromFile || undefined;
  } catch {
    return undefined;
  }
}
