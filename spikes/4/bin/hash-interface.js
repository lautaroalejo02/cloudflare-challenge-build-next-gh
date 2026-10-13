#!/usr/bin/env node
const { createHash } = require("crypto");
const { readFileSync } = require("fs");
const { resolve } = require("path");
const { Project, Node, ts } = require("ts-morph");

const printer = ts.createPrinter({ removeComments: true });

// Canonical text for a node: printer strips comments and normalizes formatting.
function ptext(node) {
  return printer.printNode(
    ts.EmitHint.Unspecified,
    node.compilerNode,
    node.getSourceFile().compilerNode
  );
}

function paramSig(p) {
  let s = "";
  const mods = p.getModifiers().map(ptext).join(" ");
  if (mods) s += mods + " ";
  if (p.isRestParameter()) s += "...";
  s += ptext(p.getNameNode());
  if (p.hasQuestionToken()) s += "?";
  const tn = p.getTypeNode();
  s += ":" + (tn ? ptext(tn) : p.getType().getText(p));
  const init = p.getInitializer();
  if (init) s += "=" + ptext(init);
  return s;
}

function fnSig(f, name) {
  const tp = f.getTypeParameters().map(ptext).join(",");
  const params = f.getParameters().map(paramSig).join(",");
  const rtn = f.getReturnTypeNode();
  const rt = rtn ? ptext(rtn) : f.getReturnType().getText(f);
  const async = f.isAsync && f.isAsync() ? "async " : "";
  return `${async}${name}${tp ? `<${tp}>` : ""}(${params}):${rt}`;
}

function isPublicMember(m) {
  if (m.getName && m.getName().startsWith("#")) return false;
  return !(
    m.hasModifier(ts.SyntaxKind.PrivateKeyword) ||
    m.hasModifier(ts.SyntaxKind.ProtectedKeyword)
  );
}

function classSig(c, exportName) {
  const name = c.getName() || exportName;
  const tp = c.getTypeParameters().map(ptext).join(",");
  const ext = c.getExtends() ? " extends " + ptext(c.getExtends()) : "";
  const impl = c.getImplements().length
    ? " implements " + c.getImplements().map(ptext).join(",")
    : "";
  const members = [];
  for (const ctor of c.getConstructors()) {
    members.push(`ctor(${ctor.getParameters().map(paramSig).join(",")})`);
  }
  for (const m of c.getMethods()) {
    if (!isPublicMember(m)) continue;
    members.push(`${m.isStatic() ? "static " : ""}${fnSig(m, m.getName())}`);
  }
  for (const p of c.getProperties()) {
    if (!isPublicMember(p)) continue;
    const tn = p.getTypeNode();
    const t = tn ? ptext(tn) : p.getType().getText(p);
    members.push(
      `${p.isStatic() ? "static " : ""}${p.isReadonly() ? "readonly " : ""}prop ${p.getName()}:${t}`
    );
  }
  members.sort();
  return `class ${name}${tp ? `<${tp}>` : ""}${ext}${impl}{${members.join(";")}}`;
}

function nodeSig(node, exportName) {
  if (Node.isFunctionDeclaration(node)) return "fn " + fnSig(node, node.getName() || exportName);
  if (Node.isVariableDeclaration(node)) {
    const init = node.getInitializer();
    const name = node.getName();
    if (init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))) {
      const async = init.isAsync() ? "async " : "";
      return "fn " + async + fnSig(init, name);
    }
    const tn = node.getTypeNode();
    return `const ${name}:${tn ? ptext(tn) : node.getType().getText(node)}`;
  }
  if (Node.isInterfaceDeclaration(node)) return "iface " + ptext(node);
  if (Node.isTypeAliasDeclaration(node)) return "type " + ptext(node);
  if (Node.isEnumDeclaration(node)) return "enum " + ptext(node);
  if (Node.isClassDeclaration(node)) return classSig(node, exportName);
  return "other " + ptext(node);
}

function signatures(filePath) {
  const project = new Project({
    compilerOptions: { strict: true },
    skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: true,
    skipLoadingLibFiles: true,
  });
  const sf = project.createSourceFile(filePath, readFileSync(filePath, "utf8"), { overwrite: true });
  const sigs = [];
  for (const [name, decls] of sf.getExportedDeclarations()) {
    for (const d of decls) sigs.push(nodeSig(d, name));
  }
  return sigs.sort();
}

function hashFile(filePath) {
  const sigs = signatures(resolve(filePath));
  return createHash("sha256").update(sigs.join("\n")).digest("hex");
}

if (require.main === module) {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: hash-interface <file>");
    process.exit(2);
  }
  if (process.argv.includes("--sigs")) {
    console.log(signatures(resolve(file)).join("\n"));
  }
  console.log(hashFile(file));
}

module.exports = { hashFile, signatures };
