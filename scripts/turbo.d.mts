export const GROUPS: Record<'check' | 'test' | 'build', string[]>;
export function defaultCacheDir(env?: Record<string, string | undefined>, home?: string): string;
export function turboEnv(env?: Record<string, string | undefined>, tools?: () => string): Record<string, string>;
export function turboArgs(args: string[]): string[];
