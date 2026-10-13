// Generates test/payloads/*.json from the shared case fixtures so the exact
// same inputs can be POSTed to the deployed proof Worker.
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as c from "./cases.mjs";

const here = dirname(fileURLToPath(import.meta.url));
mkdirSync(join(here, "payloads"), { recursive: true });

const names = ["base", "a_reformat", "b1_paramtype", "b2_addparam", "c_body", "d1_reorder", "d2_ret", "d3_iface", "priv"];
for (const n of names) {
  writeFileSync(
    join(here, "payloads", `${n}.json`),
    JSON.stringify({ files: { "src/order.ts": c[n] } }),
  );
}
console.log(`wrote ${names.length} payloads`);
