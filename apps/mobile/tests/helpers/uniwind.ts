import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import Module, { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { runInNewContext } from 'node:vm';

// uniwind's own compile of global.css, run under Node: what its Metro
// transformer hands the bundle, so a test sees the class names the app can
// use. Its transform reads the CSS entry from metro.config.js, writes uniwind's
// generated imports (node_modules/uniwind/uniwind.css, only when they change,
// as every Metro start does) and its declaration file (here to a temporary
// folder), compiles Tailwind over the app's sources, turns the CSS into
// uniwind's stylesheet, and passes the result to Metro's own transform worker
// as code. That worker is swapped here for one that hands the code back, which
// then runs against a stand-in for uniwind's runtime to get the stylesheet.
// uniwind keeps one worker per kind of project, so the swap asks for the
// non-Expo one: the Expo worker that Metro and tests/react-compiler.test.ts use
// stays untouched.

const app = join(import.meta.dirname, '../..');
const requireFromApp = createRequire(join(app, 'package.json'));

interface UniwindOptions {
    readonly cssEntryFile: string;
    readonly dtsFile: string;
    readonly isExpoProject: boolean;
    readonly extraThemes?: readonly string[];
}

interface MetroConfig {
    readonly transformerPath: string;
    readonly transformer: { readonly uniwind: UniwindOptions };
}

type Transform = (
    config: MetroConfig['transformer'],
    projectRoot: string,
    filePath: string,
    data: Buffer,
    options: Record<string, unknown>,
) => Promise<{ output: [{ data: { code: string } }] }>;

/** One class name's styles in uniwind's stylesheet: what it sets, per variant. */
export interface UniwindStyle {
    readonly entries: readonly unknown[];
}

export interface UniwindCompile {
    /** Every class name uniwind can style, as the app's className props look them up. */
    readonly stylesheet: Readonly<Record<string, readonly UniwindStyle[]>>;
    /** The theme names it registers at launch. */
    readonly themes: readonly string[];
    /** The declaration file it writes beside the compile (metro.config.js's dtsFile). */
    readonly declaration: string;
}

export const metroConfig: MetroConfig = requireFromApp('./metro.config.js');

/** global.css compiled by uniwind for `platform`, as Metro bundles it. */
export async function compileUniwind(platform: 'android' | 'ios'): Promise<UniwindCompile> {
    const requireFromTransformer = createRequire(metroConfig.transformerPath);
    const workerPath = requireFromTransformer.resolve('metro-transform-worker');
    const worker = new Module(workerPath);
    worker.filename = workerPath;
    worker.loaded = true;
    worker.exports = {
        transform: async (_config: unknown, _root: string, _file: string, data: Buffer) => ({
            output: [{ data: { code: data.toString('utf8') } }],
        }),
    };
    const { transform } = requireFromTransformer(metroConfig.transformerPath) as { transform: Transform };
    const scratch = mkdtempSync(join(tmpdir(), 'socio-uniwind-'));
    const previous = requireFromTransformer.cache[workerPath];
    requireFromTransformer.cache[workerPath] = worker;
    try {
        const uniwind = {
            ...metroConfig.transformer.uniwind,
            isExpoProject: false,
            dtsFile: join(scratch, 'uniwind.d.ts'),
        };
        // uniwind compiles the file whose path matches its entry, read against the working directory.
        const entry = relative(app, join(process.cwd(), uniwind.cssEntryFile));
        const result = await transform({ ...metroConfig.transformer, uniwind }, app, entry, Buffer.from(''), {
            platform,
            type: 'module',
            dev: false,
            customTransformOptions: {},
        });
        let registered: { build: (runtime: unknown) => { stylesheet: UniwindCompile['stylesheet'] }; themes: string[] };
        runInNewContext(result.output[0].data.code, {
            require: (name: string) => {
                if (name !== 'uniwind') {
                    throw new Error(`uniwind's compiled styles ask for ${name}`);
                }
                return {
                    Uniwind: {
                        __reinit: (build: (typeof registered)['build'], themes: string[]) => {
                            registered = { build, themes };
                        },
                    },
                };
            },
        });
        // The runtime is read only by the style functions, which this never calls.
        const runtime: unknown = new Proxy({}, { get: () => runtime });
        const { stylesheet } = registered!.build(runtime);
        return {
            stylesheet,
            themes: [...registered!.themes],
            declaration: readFileSync(uniwind.dtsFile, 'utf8'),
        };
    } finally {
        if (previous === undefined) {
            delete requireFromTransformer.cache[workerPath];
        } else {
            requireFromTransformer.cache[workerPath] = previous;
        }
        rmSync(scratch, { recursive: true, force: true });
    }
}

/** The theme names a uniwind declaration file gives `UniwindConfig.themes`. */
export function declaredThemes(declaration: string): string[] {
    const list = /themes:\s*readonly\s*\[([^\]]*)\]/.exec(declaration)?.[1];
    if (list === undefined) {
        throw new Error('No `themes: readonly [...]` in the declaration');
    }
    return [...list.matchAll(/'([^']+)'|"([^"]+)"/g)].map((match) => match[1] ?? match[2]!);
}
