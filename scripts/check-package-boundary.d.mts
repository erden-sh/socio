export function withoutComments(source: string): string;
export function importsOf(source: string): string[];
export function dynamicImportsOf(code: string): string[];
export function valueImportsOf(source: string): string[];
export const LAYERS: readonly string[];
export function packageBoundaryProblems(pkg: string): string[];
export function packageDependencyProblems(
    pkg: string,
    rootManifest: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> },
): string[];
export function packageGraphProblems(root: string): string[];
export function thirdPartyReach(root: string, entries: string[]): string[];
export const NO_DEPENDENCY_SERVICES: string[];
export function workspaceProblems(root: string): string[];
