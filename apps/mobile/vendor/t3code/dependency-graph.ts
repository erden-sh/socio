// From T3 Code (https://github.com/pingdotgg/t3code) at 240446e2d9:
// apps/mobile/src/dependency-graph.test.ts. MIT, Copyright (c) 2026 T3 Tools
// Inc (LICENSE in this folder). Socio's changes are listed in SYNC.md; the
// checks that use it are in apps/mobile/tests/dependency-graph.test.ts.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { metroCaller, metroPresetPath, mobileRoot, requireFromMobile } from "./react-compiler-coverage";

/** Dynamic imports cannot create Metro initialization cycles: they resolve after both modules initialize. */

/**
 * Metro's order (metro-resolver's resolveSourceFile, with preferNativePlatform on): each source
 * extension in turn, and inside it the platform's file, the native one, then the plain one. So
 * `foo.ts` wins over `foo.android.tsx`.
 */
export const PLATFORM_EXTENSION_ORDER = {
  android: [".android.ts", ".native.ts", ".ts", ".android.tsx", ".native.tsx", ".tsx"],
  ios: [".ios.ts", ".native.ts", ".ts", ".ios.tsx", ".native.tsx", ".tsx"],
} as const;

export type Platform = keyof typeof PLATFORM_EXTENSION_ORDER;

export const PLATFORMS = Object.keys(PLATFORM_EXTENSION_ORDER) as ReadonlyArray<Platform>;

const isGraphFile = (filePath: string): boolean =>
  /\.tsx?$/.test(filePath) &&
  !filePath.includes(".test.") &&
  !filePath.includes("test-support") &&
  !filePath.endsWith(".d.ts");

function isRelevantForPlatform(filePath: string, platform: Platform): boolean {
  const name = NodePath.basename(filePath);
  if (platform === "android") {
    return !name.includes(".ios.");
  }
  return !name.includes(".android.");
}

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of NodeFS.readdirSync(dir)) {
    const filePath = NodePath.join(dir, entry);
    if (NodeFS.statSync(filePath).isDirectory()) {
      collectSourceFiles(filePath, out);
    } else if (isGraphFile(filePath)) {
      out.push(filePath);
    }
  }
  return out;
}

export function resolveRelative(
  sourceRoot: string,
  fromFile: string,
  specifier: string,
  extensionOrder: ReadonlyArray<string>,
): string | null {
  if (!specifier.startsWith(".")) {
    return null;
  }
  const base = NodePath.resolve(NodePath.dirname(fromFile), specifier);
  // Metro's order: the specifier as a file name ('./home.tsx'), then with each extension, then
  // as a folder's index. A '.js' name also finds its '.ts' or '.tsx' file, as TypeScript and Vite
  // do (Metro does only in shared's source, through metro.config.js): an edge the tests load.
  const stem = base.endsWith(".js") ? base.slice(0, -".js".length) : null;
  const candidates = [
    base,
    ...(stem === null ? [] : [`${stem}.ts`, `${stem}.tsx`]),
    ...extensionOrder.map((ext) => base + ext),
    ...extensionOrder.map((ext) => NodePath.join(base, `index${ext}`)),
  ];
  for (const candidate of candidates) {
    try {
      if (NodeFS.statSync(candidate).isFile()) {
        const resolved = NodePath.resolve(candidate);
        return resolved.startsWith(sourceRoot + NodePath.sep) ? resolved : null;
      }
    } catch {}
  }
  return null;
}

export interface ParsedImport {
  readonly specifier: string;
  readonly isDynamic: boolean;
}

interface AstNode {
  readonly type: string;
  readonly loc?: { readonly start: { readonly line: number } } | null;
  readonly [key: string]: unknown;
}

/** The part of Babel's NodePath used here. */
interface AstPath {
  readonly node: AstNode | null | undefined;
  readonly scope: { readonly getBinding: (name: string) => unknown };
  readonly get: (key: string) => AstPath;
  readonly evaluate: () => { readonly confident: boolean; readonly value: unknown };
  readonly findParent: (test: (path: AstPath) => boolean) => AstPath | null;
}

// Imports come from Babel's AST, parsed as Metro's transformer parses the file: @babel/core (the
// app's), Expo's preset, whose TypeScript plugin turns JSX on for .tsx files only, Metro's caller
// and its sourceType. Comments and strings hold no imports, and type syntax loads nothing. Babel's
// traverse (re-exported by @babel/core) walks it, with the scopes `evaluate()` needs.
const babel: {
  parseSync: (source: string, options: Record<string, unknown>) => AstNode | null;
  traverse: (ast: AstNode, visitors: { readonly enter: (path: AstPath) => void }) => void;
} = requireFromMobile("@babel/core");
const metroPresets = [metroPresetPath];

const isAstNode = (value: unknown): value is AstNode =>
  typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";

/** The `TS*` nodes that hold code that runs; every other one is type syntax. */
const RUNTIME_TS_NODES = new Set([
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSTypeAssertion",
  "TSNonNullExpression",
  "TSInstantiationExpression",
  "TSParameterProperty",
  "TSEnumDeclaration",
  "TSEnumBody",
  "TSEnumMember",
  "TSModuleDeclaration",
  "TSModuleBlock",
  "TSExportAssignment",
  "TSImportEqualsDeclaration",
  "TSExternalModuleReference",
]);

/**
 * Syntax that loads nothing, which Babel (Metro), TypeScript and Vite erase: types, where
 * `import("x").T` and `typeof import("x")` are TSImportType nodes; type, interface and overload
 * declarations; and ambient `declare` code.
 */
const isTypeSyntax = (node: AstNode | null | undefined): boolean =>
  node != null && (node.declare === true || (node.type.startsWith("TS") && !RUNTIME_TS_NODES.has(node.type)));

const isTypeKind = (kind: unknown): boolean => kind === "type" || kind === "typeof";

/**
 * `import type`, `export type ... from`, and an `import { ... }` or `export { ... } from` whose
 * every name is `type X`. One value name (`import { type A, b }`), a default or a namespace keeps
 * the whole clause, and so does an empty one (`import {} from`), as a side-effect import.
 */
function isTypeOnlyClause(node: AstNode): boolean {
  if (isTypeKind(node.importKind) || isTypeKind(node.exportKind)) {
    return true;
  }
  const specifiers = Array.isArray(node.specifiers) ? node.specifiers.filter(isAstNode) : [];
  return (
    specifiers.length > 0 &&
    specifiers.every((specifier) => isTypeKind(specifier.importKind) || isTypeKind(specifier.exportKind))
  );
}

/** A string literal's value: a clause's `from "…"`, or the name in `import x = require("…")` or `import("…").T`. */
function stringValue(node: unknown): string | null {
  if (!isAstNode(node)) {
    return null;
  }
  if (node.type === "TSLiteralType") {
    return stringValue(node.literal);
  }
  return node.type === "StringLiteral" && typeof node.value === "string" ? node.value : null;
}

/**
 * The module name an `import()` or `require()` argument computes to, read as Metro reads it
 * (collect-dependencies' getModuleNameFromCallArgs: Babel's `evaluate()`, kept when confident and a
 * string): a string, a template, `'expo-' + 'sqlite'`, a `const` holding one. Null otherwise.
 */
function computedName(path: AstPath): string | null {
  if (path.node == null) {
    return null;
  }
  const { confident, value } = path.evaluate();
  return confident && typeof value === "string" ? value : null;
}

/** A module a file names, and whether it loads at run time. */
interface ModuleReference {
  /** Null for an `import()` or `require()` whose name Babel can't compute. */
  readonly specifier: string | null;
  readonly isDynamic: boolean;
  /** False for type-only syntax, and for a call to a `require` the file binds (Metro skips it). */
  readonly loads: boolean;
  readonly line: number;
}

/**
 * The module `path`'s node names, if any. Static: an import or `export ... from` clause, `export *`,
 * a side-effect import, `import x = require("…")`, and a `require("…")` call (wherever it is: at the
 * top it runs while the module initializes, as an import does). Dynamic: `import("…")`. And types:
 * `import("…").T` and `typeof import("…")`, which load nothing.
 */
function referenceOf(path: AstPath): Omit<ModuleReference, "line"> | null {
  const node = path.node;
  switch (node?.type) {
    case "ImportDeclaration":
    case "ExportNamedDeclaration":
    case "ExportAllDeclaration":
      return node.source == null
        ? null
        : { specifier: stringValue(node.source), isDynamic: false, loads: !isTypeOnlyClause(node) };
    case "TSImportEqualsDeclaration": {
      const reference = node.moduleReference;
      return isAstNode(reference) && reference.type === "TSExternalModuleReference"
        ? { specifier: stringValue(reference.expression), isDynamic: false, loads: !isTypeKind(node.importKind) }
        : null;
    }
    case "TSImportType":
      return { specifier: stringValue(node.argument), isDynamic: false, loads: false };
    case "ImportExpression":
      return { specifier: computedName(path.get("source")), isDynamic: true, loads: true };
    case "CallExpression": {
      const callee = isAstNode(node.callee) ? node.callee : null;
      if (callee?.type === "Import") {
        return { specifier: computedName(path.get("arguments.0")), isDynamic: true, loads: true };
      }
      if (callee?.type === "Identifier" && callee.name === "require") {
        const loads = path.scope.getBinding("require") === undefined;
        return { specifier: computedName(path.get("arguments.0")), isDynamic: false, loads };
      }
      return null;
    }
    default:
      return null;
  }
}

/**
 * Every module `source` names, in source order, from Babel's AST of it as Metro parses `filename`
 * (whose extension picks the dialect: JSX in .tsx only). Anything inside type syntax
 * (isTypeSyntax) or a type-only clause (isTypeOnlyClause) loads nothing. A file Metro can't parse
 * throws.
 */
function moduleReferences(source: string, filename: string): ModuleReference[] {
  const ast = babel.parseSync(source, {
    babelrc: false,
    configFile: false,
    cwd: mobileRoot,
    filename: NodePath.resolve(mobileRoot, filename),
    presets: metroPresets,
    caller: metroCaller,
    sourceType: "unambiguous",
  });
  if (ast === null) {
    throw new Error(`Babel gave no AST for ${filename}`);
  }
  const found: ModuleReference[] = [];
  babel.traverse(ast, {
    enter(path) {
      const reference = referenceOf(path);
      if (reference !== null) {
        const inType = path.findParent((parent) => isTypeSyntax(parent.node)) !== null;
        found.push({ ...reference, loads: reference.loads && !inType, line: path.node?.loc?.start.line ?? 0 });
      }
    },
  });
  return found;
}

/**
 * The modules `source` loads at run time, in source order (moduleReferences). Type-only syntax
 * is skipped. An `import()` or `require()` whose name Babel can't compute throws: the graph can't
 * follow it, and Metro, which bundles any name it can compute, rejects one it can't in the app.
 */
export function parseImports(source: string, filename: string): ParsedImport[] {
  return moduleReferences(source, filename).flatMap(({ specifier, isDynamic, loads, line }) => {
    if (!loads) {
      return [];
    }
    if (specifier === null) {
      throw new Error(`${filename}:${line}: an import() or require() of a name the graph can't compute`);
    }
    return [{ specifier, isDynamic }];
  });
}

/**
 * Every module `source` names (moduleReferences), type-only syntax, ambient code and a local
 * `require` included, for a ban that covers types too. An `import()` or `require()` whose name
 * Babel can't compute names nothing.
 */
export function moduleNames(source: string, filename: string): string[] {
  return moduleReferences(source, filename).flatMap(({ specifier }) => (specifier === null ? [] : [specifier]));
}

export interface PlatformGraph {
  readonly sourceRoot: string;
  readonly platform: Platform;
  readonly files: ReadonlyArray<string>;
  readonly staticEdges: ReadonlyMap<string, ReadonlyArray<string>>;
}

export function buildPlatformGraph(sourceRoot: string, platform: Platform): PlatformGraph {
  const extensionOrder = PLATFORM_EXTENSION_ORDER[platform];
  const files = collectSourceFiles(sourceRoot)
    .filter((file) => isRelevantForPlatform(file, platform))
    .sort();
  const staticEdges = new Map<string, string[]>();
  for (const file of files) {
    const targets = new Set<string>();
    for (const { specifier, isDynamic } of parseImports(NodeFS.readFileSync(file, "utf8"), file)) {
      const resolved = resolveRelative(sourceRoot, file, specifier, extensionOrder);
      if (resolved === null || resolved === file) {
        continue;
      }
      if (!isDynamic) {
        targets.add(resolved);
      }
    }
    staticEdges.set(file, [...targets]);
  }
  return { sourceRoot, platform, files, staticEdges };
}

export function findCycles(graph: PlatformGraph): ReadonlyArray<ReadonlyArray<string>> {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const cycles: string[][] = [];
  let nextIndex = 0;

  const enter = (node: string): void => {
    index.set(node, nextIndex);
    low.set(node, nextIndex);
    nextIndex += 1;
    stack.push(node);
    onStack.add(node);
  };

  for (const root of graph.files) {
    if (index.has(root)) continue;
    const work: Array<[string, number]> = [[root, 0]];
    enter(root);
    while (work.length > 0) {
      const frame = work[work.length - 1]!;
      const neighbors = graph.staticEdges.get(frame[0]) ?? [];
      let advanced = false;
      for (let i = frame[1]; i < neighbors.length; i += 1) {
        const child = neighbors[i]!;
        if (!graph.staticEdges.has(child)) continue;
        if (!index.has(child)) {
          work[work.length - 1] = [frame[0], i + 1];
          work.push([child, 0]);
          enter(child);
          advanced = true;
          break;
        } else if (onStack.has(child)) {
          low.set(frame[0], Math.min(low.get(frame[0])!, index.get(child)!));
        }
      }
      if (advanced) continue;
      work.pop();
      const parent = work[work.length - 1];
      if (parent) {
        low.set(parent[0], Math.min(low.get(parent[0])!, low.get(frame[0])!));
      }
      if (low.get(frame[0]) === index.get(frame[0])) {
        const component: string[] = [];
        let member: string;
        do {
          member = stack.pop()!;
          onStack.delete(member);
          component.push(member);
        } while (member !== frame[0]);
        if (component.length > 1) {
          cycles.push(component.sort().map((file) => NodePath.relative(graph.sourceRoot, file)));
        }
      }
    }
  }
  return cycles;
}
