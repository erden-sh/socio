// From T3 Code (https://github.com/pingdotgg/t3code) at 240446e2d9:
// apps/mobile/src/reactCompilerCoverage.test.ts. MIT, Copyright (c) 2026 T3
// Tools Inc (LICENSE in this folder). Socio's changes are listed in SYNC.md;
// the checks that use it are in apps/mobile/tests/react-compiler.test.ts.
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";

export const mobileRoot = NodePath.resolve(import.meta.dirname, "../..");
export const requireFromMobile = NodeModule.createRequire(NodePath.join(mobileRoot, "package.json"));
const babel: {
  transformFileSync: (file: string, options: Record<string, unknown>) => unknown;
} = requireFromMobile("@babel/core");
const metroConfig: { transformer: { babelTransformerPath: string } } =
  requireFromMobile("./metro.config.js");

// The app has no Babel config file, so Metro's transformer runs Expo's default
// preset, which it loads itself as `expo/internal/babel-preset` (a re-export of
// babel-preset-expo). Resolve it from the transformer, as the transformer does.
export const metroTransformerPath = metroConfig.transformer.babelTransformerPath;
const requireFromTransformer = NodeModule.createRequire(metroTransformerPath);
export const metroPresetPath = requireFromTransformer.resolve("expo/internal/babel-preset");

// Use Metro's iOS release flags; experiments.reactCompiler enables supportsReactCompiler.
export const metroCaller = {
  name: "metro",
  bundler: "metro",
  platform: "ios",
  isDev: false,
  isServer: false,
  isNodeModule: false,
  supportsStaticESM: true,
  supportsReactCompiler: true,
};

export const sourceFiles = NodeFS.readdirSync(NodePath.join(mobileRoot, "src"), { recursive: true })
  .map(String)
  .filter((file) => /\.tsx?$/.test(file) && !/\.(test\.tsx?|d\.ts)$/.test(file))
  .map((file) => `src/${file.split(NodePath.sep).join("/")}`)
  .sort();

type CompilerLoc = { readonly start?: { readonly line?: number } } | null;

export interface CompilerEvent {
  readonly kind: string;
  readonly fnLoc?: CompilerLoc;
  readonly data?: string;
  readonly detail?: {
    readonly options?: {
      readonly category?: string;
      readonly reason?: string;
      readonly loc?: CompilerLoc;
      readonly details?: readonly { readonly loc?: CompilerLoc }[];
    };
  };
}

// The preset Metro loads, with Metro's caller; the logger rides on the preset's
// own react-compiler option so the plugin runs with Metro's exact settings.
function compileLikeMetro(file: string, events: CompilerEvent[], output: Record<string, unknown>) {
  return babel.transformFileSync(NodePath.resolve(mobileRoot, file), {
    babelrc: false,
    configFile: false,
    cwd: mobileRoot,
    presets: [
      [
        metroPresetPath,
        {
          "react-compiler": {
            logger: { logEvent: (_: string, event: CompilerEvent) => events.push(event) },
          },
        },
      ],
    ],
    caller: metroCaller,
    code: false,
    ...output,
  });
}

// A PipelineError is an exception inside the compiler (`data` is its stack). It
// leaves the function uncompiled like a CompileError, and as silently in a
// release build, where babel-preset-expo sets panicThreshold 'NONE'.
export function bailoutsIn(events: readonly CompilerEvent[]): string[] {
  return events
    .filter(
      (event) =>
        event.kind === "CompileError" || event.kind === "CompileSkip" || event.kind === "PipelineError",
    )
    .map(
      (event) =>
        `line ${(event.detail?.options?.loc ?? event.detail?.options?.details?.[0]?.loc ?? event.fnLoc)?.start?.line ?? "?"}: ${event.detail?.options?.category ?? event.kind} ${event.detail?.options?.reason ?? event.data?.split("\n")[0] ?? ""}`,
    );
}

export function compilerBailouts(file: string): string[] {
  const events: CompilerEvent[] = [];
  compileLikeMetro(file, events, {});
  return bailoutsIn(events);
}

interface AstNode {
  readonly type: string;
  readonly [key: string]: unknown;
}

const isAstNode = (value: unknown): value is AstNode =>
  typeof value === "object" && value !== null && "type" in value && typeof value.type === "string";

function walkAst(
  value: unknown,
  visit: (node: AstNode, ancestors: readonly AstNode[]) => void,
  ancestors: readonly AstNode[] = [],
) {
  if (typeof value !== "object" || value === null) return;
  const node = isAstNode(value) ? value : null;
  if (node) visit(node, ancestors);
  const childAncestors = node ? [...ancestors, node] : ancestors;
  for (const child of Object.values(value)) walkAst(child, visit, childAncestors);
}

// For each call to `callee`, whether it runs only on the cache-miss branch of
// an `if ($[n] !== dep)` block rather than on every render.
export function compilerCachedCalls(file: string, callee: string): boolean[] {
  const result = compileLikeMetro(file, [], { ast: true });
  const cached: boolean[] = [];
  if (typeof result !== "object" || result === null || !("ast" in result)) return cached;
  walkAst(result.ast, (node, ancestors) => {
    if (node.type !== "CallExpression" || !isAstNode(node.callee)) return;
    if (node.callee.type !== "Identifier" || node.callee.name !== callee) return;
    cached.push(
      ancestors.some(
        (ancestor, index) =>
          ancestor.type === "IfStatement" &&
          ancestors[index + 1] === ancestor.consequent &&
          JSON.stringify(ancestor.test).includes('"name":"$"'),
      ),
    );
  });
  return cached;
}

// Metro's own transformer on `file`, as Expo CLI calls it for an iOS release
// bundle, with the compiler on or off; the program body as JSON.
export function transformWithMetro(file: string, reactCompiler: string): string {
  const metroTransformer = requireFromMobile(metroTransformerPath);
  const filename = NodePath.join(mobileRoot, file);
  const { ast } = metroTransformer.transform({
    filename,
    src: NodeFS.readFileSync(filename, "utf8"),
    plugins: [],
    options: {
      dev: false,
      hot: false,
      platform: "ios",
      projectRoot: mobileRoot,
      type: "module",
      enableBabelRCLookup: false,
      experimentalImportSupport: false,
      customTransformOptions: { reactCompiler, routerRoot: "app" },
    },
  });
  return JSON.stringify(ast.program.body);
}

/** Expo's own check for a Babel config file in `projectRoot`, the one its transformer runs. */
export function babelConfigFileIn(projectRoot: string): string | undefined {
  return requireFromTransformer("./loadBabelConfig.js").resolveBabelrcName(projectRoot);
}
