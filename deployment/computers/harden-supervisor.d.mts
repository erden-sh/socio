// Types for harden-supervisor.mjs: each patch takes the pinned OpenBot
// source of one file and returns it patched, or throws when the upstream
// text it replaces changed.
export function hardenSupervisorEnvironment(source: string): string;
export function hardenSupervisorNames(source: string): string;
export function hardenSupervisorDocker(source: string): string;
export function hardenSupervisorRoutes(source: string): string;
export function hardenSupervisorSandboxes(source: string): string;
