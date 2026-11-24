export function workspaceDependencies(manifest: {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
}): string[];
export function builtPackages(root: string): {
    name: string;
    dir: string;
    manifest: Record<string, unknown>;
    tsconfig: string;
    build: string;
}[];
