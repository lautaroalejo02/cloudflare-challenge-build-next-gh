import { Parser, Language } from "web-tree-sitter";
import type { Node } from "web-tree-sitter";

export interface SymbolSignature {
  name: string;
  kind: "function" | "type" | "interface" | "class" | "const";
  signature: string;
  hash: string;
}

export interface InterfaceHash {
  hash: string;
  symbols: SymbolSignature[];
}

// ---------------------------------------------------------------------------
// Parser lifecycle.
//
// Two init modes (see NOTES.md):
//  1. Explicit: the caller hands us both wasm modules via initHasher(). Node
//     tests use this with `new WebAssembly.Module(fs.readFileSync(...))`.
//  2. Lazy: hashInterface() dynamically imports ./wasm-modules.ts, which
//     statically imports both .wasm files. Inside a Worker bundle built with
//     `rules = [{ type = "CompiledWasm", globs = ["**/*.wasm"] }]` these
//     resolve to WebAssembly.Module instances (spike 6 pattern), so a Worker
//     consumer only needs `import { hashInterface }` plus the CompiledWasm
//     rule in its own wrangler.toml.
// ---------------------------------------------------------------------------

type WasmModule = WebAssembly.Module;

let parserPromise: Promise<Parser> | null = null;

export function initHasher(
  runtimeWasm: WasmModule,
  grammarWasm: WasmModule,
): Promise<void> {
  parserPromise ??= (async () => {
    await Parser.init({
      instantiateWasm: (imports, cb) => {
        WebAssembly.instantiate(runtimeWasm, imports).then((inst) =>
          cb(inst as never, runtimeWasm as never),
        );
      },
    });
    const lang = Language.loadSync(grammarWasm);
    const parser = new Parser();
    parser.setLanguage(lang);
    return parser;
  })();
  return parserPromise.then(() => undefined);
}

async function getParser(): Promise<Parser> {
  if (!parserPromise) {
    const { runtimeWasm, grammarWasm } = await import("./wasm-modules.ts");
    initHasher(runtimeWasm, grammarWasm);
  }
  return parserPromise!;
}

// ---------------------------------------------------------------------------
// Canonical text. Walks the syntax tree and emits only leaf tokens, joined so
// that formatting never matters: whitespace is reconstructed from token
// boundaries, comments and decorators are dropped, `;` terminators and member
// separators are dropped, and function/method bodies are skipped entirely.
// ---------------------------------------------------------------------------

// Nodes whose `body` child is an implementation, not part of the interface.
const BODIED = new Set([
  "function_declaration",
  "generator_function_declaration",
  "function_signature",
  "method_definition",
  "function_expression",
  "arrow_function",
]);

// `,` only separates members in these bodies; elsewhere it is semantic.
const COMMA_BODIES = new Set([
  "interface_body",
  "object_type",
  "enum_body",
  "class_body",
]);

const SKIP_NODES = new Set(["comment", "decorator"]);

function isPunct(ch: string): boolean {
  return !/[A-Za-z0-9_$]/.test(ch);
}

function canon(node: Node): string {
  let out = "";
  const visit = (n: Node): void => {
    if (SKIP_NODES.has(n.type)) return;
    if (n.childCount === 0) {
      const t = n.text;
      if (t === ";") return;
      const parent = n.parent;
      if (t === "," && parent && COMMA_BODIES.has(parent.type)) return;
      if (out === "" || isPunct(t[0]) || isPunct(out[out.length - 1])) out += t;
      else out += " " + t;
      return;
    }
    const bodied = BODIED.has(n.type);
    for (let i = 0; i < n.childCount; i++) {
      const c = n.child(i)!;
      if (bodied && n.fieldNameForChild(i) === "body") continue;
      visit(c);
    }
  };
  visit(node);
  return out;
}

// ---------------------------------------------------------------------------
// Type inference, only for places that have no explicit type annotation. The
// parser cannot type-check, so this maps literal-ish initializer/return
// expressions to type names; anything complex becomes "unknown". Deterministic
// per source, which is all the hash needs.
// ---------------------------------------------------------------------------

function inferExprType(n: Node | null): string {
  if (!n) return "unknown";
  switch (n.type) {
    case "number":
      return "number";
    case "string":
    case "template_string":
      return "string";
    case "regex":
      return "RegExp";
    case "true":
    case "false":
      return "boolean";
    case "null":
      return "null";
    case "array": {
      const kinds = new Set<string>();
      for (const c of n.children) {
        if (isPunct(c.text[0] ?? "") && c.childCount === 0) continue;
        kinds.add(inferExprType(c));
      }
      const only = kinds.size === 1 ? [...kinds][0] : "unknown";
      return `${only}[]`;
    }
    case "object":
      return "object";
    case "new_expression": {
      const ctor = n.childForFieldName("constructor");
      return ctor ? canon(ctor) : "unknown";
    }
    case "unary_expression": {
      const op = n.childForFieldName("operator")?.text ?? n.child(0)?.text;
      if (op === "+" || op === "-" || op === "~") return "number";
      if (op === "!") return "boolean";
      if (op === "void") return "undefined";
      return "unknown";
    }
    case "parenthesized_expression":
      return inferExprType(n.children.find((c) => c.childCount > 0) ?? null);
    case "non_null_expression":
      return inferExprType(n.child(0));
    case "as_expression": {
      // `<expr> as <type>`: the type is the child after the `as` leaf.
      const kids = n.children;
      const at = kids.findIndex((c) => c.text === "as" && c.childCount === 0);
      return at >= 0 && kids[at + 1] ? canon(kids[at + 1]) : "unknown";
    }
    case "satisfies_expression":
      return inferExprType(n.child(0));
    case "ternary_expression": {
      const a = inferExprType(n.childForFieldName("consequence"));
      const b = inferExprType(n.childForFieldName("alternative"));
      return a === b ? a : "unknown";
    }
    case "identifier":
      return n.text === "undefined" ? "undefined" : "unknown";
    default:
      return "unknown";
  }
}

const FUNCTION_LIKE = new Set([
  "function_declaration",
  "generator_function_declaration",
  "function_signature",
  "function_expression",
  "arrow_function",
  "method_definition",
]);

function inferReturnType(fn: Node): string {
  const body = fn.childForFieldName("body");
  if (!body) return "void";
  if (body.type !== "statement_block") return inferExprType(body);
  const kinds = new Set<string>();
  const walk = (n: Node): void => {
    if (n !== body && FUNCTION_LIKE.has(n.type)) return;
    if (n.type === "return_statement") {
      const expr = n.children.find(
        (c) => c.childCount > 0 || !["return", ";"].includes(c.text),
      );
      kinds.add(expr ? inferExprType(expr) : "void");
      return;
    }
    for (const c of n.children) walk(c);
  };
  walk(body);
  if (kinds.size === 0) return "void";
  if (kinds.size === 1) return [...kinds][0];
  if (kinds.has("unknown")) return "unknown";
  return [...kinds].sort().join("|");
}

// ---------------------------------------------------------------------------
// Signature builders (ported from spike 4's ts-morph rules to tree-sitter).
// ---------------------------------------------------------------------------

function annotType(n: Node | null): string | null {
  if (!n) return null;
  const t = canon(n);
  return t.startsWith(":") ? t.slice(1) : t;
}

// Modifier keywords that appear as leaf children before the `name` field.
// Node wrappers are re-created per accessor call, so the scan stops at the
// child index whose field name is "name" rather than by object identity.
function callableMods(node: Node): string {
  const mods = new Set<string>();
  for (let i = 0; i < node.childCount; i++) {
    if (node.fieldNameForChild(i) === "name") break;
    const c = node.child(i)!;
    if (c.childCount !== 0) continue;
    if (["static", "abstract", "async", "readonly", "override", "declare", "get", "set", "accessor", "*"].includes(c.text)) {
      mods.add(c.text);
    }
  }
  const ordered = [...mods].sort();
  return ordered.length ? ordered.join(" ") + " " : "";
}

function fnSignature(name: string, fn: Node): string {
  const tpNode = fn.childForFieldName("type_parameters");
  const paramsNode = fn.childForFieldName("parameters");
  const params = paramsNode
    ? paramsNode.type === "formal_parameters"
      ? canon(paramsNode)
      : `(${canon(paramsNode)})`
    : "()";
  const ret =
    annotType(fn.childForFieldName("return_type")) ?? inferReturnType(fn);
  return `fn ${callableMods(fn)}${name}${tpNode ? canon(tpNode) : ""}${params}:${ret}`;
}

const VISIBILITY = new Set(["private", "protected"]);

function isPublicMember(m: Node): boolean {
  const name = m.childForFieldName("name");
  if (name && name.type === "private_property_identifier") return false;
  for (const c of m.children) {
    if (c.type === "accessibility_modifier" && VISIBILITY.has(c.text)) {
      return false;
    }
  }
  return true;
}

function memberSignature(m: Node): string | null {
  if (!isPublicMember(m)) return null;
  const nameNode = m.childForFieldName("name");
  const mods = callableMods(m);
  const opt = m.children.some((c) => c.childCount === 0 && c.text === "?")
    ? "?"
    : "";
  if (
    m.type === "method_definition" ||
    m.type === "method_signature" ||
    m.type === "abstract_method_signature"
  ) {
    const name = nameNode?.text ?? "<computed>";
    if (name === "constructor") {
      const params = m.childForFieldName("parameters");
      return `${mods}ctor${params ? canon(params) : "()"}`;
    }
    const tp = m.childForFieldName("type_parameters");
    const params = m.childForFieldName("parameters");
    const ret =
      annotType(m.childForFieldName("return_type")) ?? inferReturnType(m);
    return `${mods}${name}${opt}${tp ? canon(tp) : ""}${params ? canon(params) : "()"}:${ret}`;
  }
  if (m.type === "public_field_definition" || m.type === "property_signature") {
    const name = nameNode ? canon(nameNode) : "<computed>";
    const t =
      annotType(m.childForFieldName("type")) ??
      inferExprType(m.childForFieldName("value"));
    return `${mods}prop ${name}${opt}:${t}`;
  }
  return canon(m);
}

function bodyMembers(node: Node | null): Node[] {
  if (!node) return [];
  return node.children.filter(
    (c) =>
      !SKIP_NODES.has(c.type) &&
      !(c.childCount === 0 && ["{", "}", ",", ";"].includes(c.text)),
  );
}

function classSignature(cls: Node, exportName: string): string {
  const name = cls.childForFieldName("name")?.text ?? exportName;
  const tp = cls.childForFieldName("type_parameters");
  const heritage = cls.children.find((c) => c.type === "class_heritage");
  const mods = callableMods(cls);
  const members = bodyMembers(cls.childForFieldName("body"))
    .map(memberSignature)
    .filter((s): s is string => s !== null)
    .sort();
  return `${mods}class ${name}${tp ? canon(tp) : ""}${heritage ? " " + canon(heritage) : ""}{${members.join(";")}}`;
}

function joinCanon(parts: string[]): string {
  let out = "";
  for (const p of parts) {
    if (out === "" || isPunct(p[0]) || isPunct(out[out.length - 1])) out += p;
    else out += " " + p;
  }
  return out;
}

function interfaceSignature(iface: Node): string {
  // Node wrappers are re-created per accessor call, so identify the body child
  // by field name instead of object identity.
  const head = joinCanon(
    iface.children
      .filter((_, i) => iface.fieldNameForChild(i) !== "body")
      .map(canon),
  );
  const members = bodyMembers(iface.childForFieldName("body"))
    .map(canon)
    .join(";");
  return `${head}{${members}}`;
}

function declaratorSignature(decl: Node, kw: string): { name: string; kind: SymbolSignature["kind"]; signature: string } | null {
  const nameNode = decl.childForFieldName("name");
  if (!nameNode) return null;
  const name = nameNode.type === "identifier" ? nameNode.text : canon(nameNode);
  const init = decl.childForFieldName("value");
  if (init && (init.type === "arrow_function" || init.type === "function_expression")) {
    return { name, kind: "function", signature: fnSignature(name, init) };
  }
  const t =
    annotType(decl.childForFieldName("type")) ?? inferExprType(init);
  return { name, kind: "const", signature: `${kw} ${name}:${t}` };
}

// One exported declaration -> zero or more {name, kind, signature} symbols.
function declSymbols(
  decl: Node,
  exportName: string | null,
): Array<{ name: string; kind: SymbolSignature["kind"]; signature: string }> {
  const d =
    decl.type === "ambient_declaration"
      ? (decl.children.find((c) => c.childCount > 0) ?? decl)
      : decl;
  switch (d.type) {
    case "function_declaration":
    case "generator_function_declaration":
    case "function_signature": {
      const name = d.childForFieldName("name")?.text ?? exportName ?? "default";
      return [{ name, kind: "function", signature: fnSignature(name, d) }];
    }
    case "variable_declarator": {
      const parent = d.parent;
      const kw =
        parent?.childForFieldName("kind")?.text ??
        (parent?.type === "variable_declaration" ? "var" : "const");
      const s = declaratorSignature(d, kw);
      return s ? [s] : [];
    }
    case "lexical_declaration":
    case "variable_declaration": {
      const kw =
        d.childForFieldName("kind")?.text ??
        (d.type === "variable_declaration" ? "var" : "const");
      const out = [];
      for (const c of d.children) {
        if (c.type !== "variable_declarator") continue;
        const s = declaratorSignature(c, kw);
        if (s) out.push(s);
      }
      return out;
    }
    case "interface_declaration":
      return [
        {
          name: d.childForFieldName("name")?.text ?? exportName ?? "default",
          kind: "interface",
          signature: interfaceSignature(d),
        },
      ];
    case "type_alias_declaration": {
      const name = d.childForFieldName("name")?.text ?? exportName ?? "default";
      const value = d.childForFieldName("value");
      const tp = d.childForFieldName("type_parameters");
      const head = `type ${name}${tp ? canon(tp) : ""}`;
      return [{ name, kind: "type", signature: `${head}=${value ? canon(value) : "unknown"}` }];
    }
    case "enum_declaration": {
      const name = d.childForFieldName("name")?.text ?? exportName ?? "default";
      const body = d.childForFieldName("body");
      const members = body
        ? body.children
            .filter((c) => c.type === "enum_assignment" || c.type === "property_identifier")
            .map(canon)
            .join(",")
        : "";
      return [{ name, kind: "type", signature: `enum ${name}{${members}}` }];
    }
    case "class_declaration":
    case "abstract_class_declaration": {
      const name = d.childForFieldName("name")?.text ?? exportName ?? "default";
      return [{ name, kind: "class", signature: classSignature(d, name) }];
    }
    default:
      return [
        {
          name: d.childForFieldName("name")?.text ?? exportName ?? "default",
          kind: "type",
          signature: canon(d),
        },
      ];
  }
}

// ---------------------------------------------------------------------------
// Export collection. Pass 1 indexes every top-level declaration by local name;
// pass 2 resolves export statements, including `export {a}` / `export {a} from`
// / `export * from` (resolved inside the same `files` map).
// ---------------------------------------------------------------------------

interface Sym {
  name: string;
  kind: SymbolSignature["kind"];
  signature: string;
}

function normalizePath(p: string): string {
  const parts: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return parts.join("/");
}

function resolveModule(spec: string, importer: string, files: Record<string, string>): string | null {
  const dir = importer.split("/").slice(0, -1).join("/");
  const base = normalizePath(dir === "" ? spec : `${dir}/${spec}`);
  for (const cand of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) {
    if (cand in files) return cand;
  }
  return null;
}

const TOP_DECLS = new Set([
  "function_declaration",
  "generator_function_declaration",
  "function_signature",
  "class_declaration",
  "abstract_class_declaration",
  "interface_declaration",
  "type_alias_declaration",
  "enum_declaration",
  "lexical_declaration",
  "variable_declaration",
  "internal_module",
  "module",
  "ambient_declaration",
]);

function indexDecl(d: Node, locals: Map<string, Node>): void {
  const inner =
    d.type === "ambient_declaration"
      ? (d.children.find((c) => c.childCount > 0) ?? d)
      : d;
  if (inner.type === "lexical_declaration" || inner.type === "variable_declaration") {
    for (const c of inner.children) {
      if (c.type !== "variable_declarator") continue;
      const n = c.childForFieldName("name");
      if (n?.type === "identifier" && !locals.has(n.text)) locals.set(n.text, c);
    }
    return;
  }
  const n = inner.childForFieldName("name");
  if (n && !locals.has(n.text)) locals.set(n.text, inner);
}

function collectExports(
  parser: Parser,
  path: string,
  files: Record<string, string>,
  visiting: Set<string>,
): Sym[] {
  if (visiting.has(path)) return [];
  visiting.add(path);
  const tree = parser.parse(files[path]);
  const top = tree.rootNode.children;

  const locals = new Map<string, Node>();
  for (const node of top) {
    if (TOP_DECLS.has(node.type)) indexDecl(node, locals);
  }

  const syms: Sym[] = [];
  const pushDecl = (decl: Node, exportName: string | null): void => {
    for (const s of declSymbols(decl, exportName)) {
      syms.push({ name: s.name, kind: s.kind, signature: s.signature });
    }
  };

  for (const node of top) {
    if (node.type !== "export_statement") continue;
    const clause = node.children.find((c) => c.type === "export_clause");
    const source = node.childForFieldName("source");
    const spec = source ? source.text.slice(1, -1) : null;
    const target =
      spec !== null ? resolveModule(spec, path, files) : null;
    const targetExports =
      spec !== null && target !== null
        ? collectExports(parser, target, files, visiting)
        : [];

    if (node.children.some((c) => c.childCount === 0 && c.text === "*")) {
      for (const s of targetExports) {
        if (s.name !== "default") syms.push(s);
      }
      continue;
    }
    if (clause) {
      for (const sp of clause.children) {
        if (sp.type !== "export_specifier") continue;
        const local = sp.childForFieldName("name")?.text;
        const exported = sp.childForFieldName("alias")?.text ?? local;
        if (!local || !exported) continue;
        if (spec !== null) {
          for (const s of targetExports) {
            if (s.name === local) syms.push({ ...s, name: exported });
          }
          continue;
        }
        const decl = locals.get(local);
        if (decl) {
          for (const s of declSymbols(decl, local)) {
            syms.push({ ...s, name: exported });
          }
        }
      }
      continue;
    }
    const decl = node.childForFieldName("declaration");
    if (decl) {
      const isDefault = node.children.some(
        (c) => c.childCount === 0 && c.text === "default",
      );
      pushDecl(decl, isDefault ? "default" : null);
      continue;
    }
    if (node.children.some((c) => c.childCount === 0 && c.text === "default")) {
      const expr = node.children.find(
        (c) =>
          c.childCount > 0 &&
          !["export", "default"].includes(c.text),
      );
      if (expr) {
        syms.push({
          name: "default",
          kind: "const",
          signature: `const default:${inferExprType(expr)}`,
        });
      }
    }
  }
  visiting.delete(path);
  return syms;
}

// ---------------------------------------------------------------------------
// Public API (app/CONTRACTS.md).
// ---------------------------------------------------------------------------

async function sha256_12(text: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 12);
}

export async function hashInterface(
  files: Record<string, string>,
): Promise<InterfaceHash> {
  const parser = await getParser();
  const seen = new Set<string>();
  const symbols: SymbolSignature[] = [];
  for (const path of Object.keys(files).sort()) {
    if (files[path] === undefined) continue;
    for (const s of collectExports(parser, path, files, new Set())) {
      const key = `${s.name} ${s.signature}`;
      if (seen.has(key)) continue;
      seen.add(key);
      symbols.push({
        name: s.name,
        kind: s.kind,
        signature: s.signature,
        hash: await sha256_12(s.signature),
      });
    }
  }
  symbols.sort(
    (a, b) => a.name.localeCompare(b.name) || a.signature.localeCompare(b.signature),
  );
  const normalized = symbols.map((s) => `${s.name} ${s.signature}`).join("\n");
  return { hash: await sha256_12(normalized), symbols };
}
