export const SERVER: string;
export const BASELINE: string;
export const RANKS: string;
export const REFERENCE_DIR: string;
export const ENTRY_FILES: ReadonlySet<string>;
export const ENTRY_PREFIXES: readonly string[];
export const CONTRACT_TYPE_IMPORTS: readonly string[];
export function featureOf(file: string): string;
export function isEntry(file: string): boolean;
export function isContract(file: string): boolean;
export function isLayer(file: string): boolean;
export const TYPESCRIPT_MODULE: RegExp;
export const RESOLUTION: Record<string, unknown>;

/** A reference that names no file in src/server: a package, or a path outside it. */
export interface PackageReference {
    specifier: string;
    line: number;
    /** `import type`, `export type ... from`, `import type x = require()` or an `import('...')` type. */
    typeOnly: boolean;
}
export interface ServerGraph {
    files: string[];
    edges: Array<{ from: string; to: string; spawn?: boolean }>;
    packages: Map<string, PackageReference[]>;
    unresolved: string[];
    unsupported: string[];
    unclassified: string[];
    /** Each `Effect.run*` or `ManagedRuntime.make` use from the effect package (`use`: `Effect.runPromise`, ...). */
    runtimeUses: Array<{ file: string; line: number; use: string }>;
}
export interface SccNumbers {
    largestFileScc: number;
    largestCrossFeatureScc: number;
    largestFeatureScc: number;
}
export interface Baseline {
    numbers: SccNumbers;
    contractOnly: string[];
}
export type Reference =
    | { baseline: Baseline; from: string; skip?: undefined }
    | { skip: string; baseline?: undefined; from?: undefined };

export interface AllowedUnread {
    file: string;
    code: string;
    why: string;
}
export const ALLOWED_UNREAD: readonly AllowedUnread[];
export function serverGraph(root: string, allowed?: readonly AllowedUnread[]): ServerGraph;
export function components(nodes: string[], edges: Array<{ from: string; to: string }>): string[][];
export function sccNumbers(graph: ServerGraph): SccNumbers;
export function contractOnlyImports(graph: ServerGraph): string[];
export function ruleProblems(graph: ServerGraph): string[];
export function measure(graph: ServerGraph): Baseline;
export function parseBaseline(text: string, where: string): Baseline;
export function formatBaseline(baseline: Baseline): string;
export function baselineProblems(current: Baseline, baseline: Baseline): string[];
/** The key (`A -> B/file.ts`: source feature, target file) the history rule holds a rule 1 entry under. */
export function historyKey(entry: string): string;
export function historyProblems(baseline: Baseline, reference: Baseline): string[];
export function referenceBaseline(root: string): Reference;
export function readBaseline(root: string): Baseline;

export interface Ranks {
    /** Feature names, top first. */
    order: string[];
}
export interface RankReport {
    up: string[];
    upFeatures: string[];
    down: number;
    unrankedImports: number;
    unranked: string[];
    stale: string[];
}
export function parseRanks(text: string, where: string): Ranks;
export function readRanks(root: string): Ranks;
export function rankReport(graph: ServerGraph, order: readonly string[]): RankReport;

export const EFFECT_RUNS: readonly string[];
export const RUN_ENTRY_FILES: ReadonlySet<string>;
export function isPlatformNeeds(file: string): boolean;
export function mayRunEffects(file: string): boolean;
export function mayMakeRuntimes(file: string): boolean;
export interface RuntimeReport {
    /** Each platform-needs.ts. */
    platformNeeds: string[];
    /** Each `Effect.run*` outside mayRunEffects, as `file:line: use`. */
    effectRuns: string[];
    /** Each `ManagedRuntime.make` outside mayMakeRuntimes, as `file:line: use`. */
    managedRuntimes: string[];
}
export function runtimeReport(graph: ServerGraph): RuntimeReport;
/** Each runtime hit as a failure, with its file and line. */
export function runtimeProblems(graph: ServerGraph): string[];
