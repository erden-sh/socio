export function packagesLoadedBy(entry: string): Promise<Map<string, string>>;
export function ssrDepsProblems(root: string): Promise<string[]>;
