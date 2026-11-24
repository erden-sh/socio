// Types for grok-pin.mjs (CB-326, built from source).
export interface GrokPin {
    version: string;
    repository: string;
    /** xAI's release tag for the commit, or '' when it has none. */
    tag: string;
    commit: string;
    source_rev: string;
    fetched: string;
    verified: string;
}
export const GROK_PIN: { id: string; label: string; path: string; arg: string };
export const GROK_REPOSITORY: string;
export function parseGrokPin(text: string): GrokPin;
export function dockerfileGrok(dockerfile: string): { version: string; repository: string };
export function checkGrokPin(pinText: string, dockerfile: string): GrokPin;
