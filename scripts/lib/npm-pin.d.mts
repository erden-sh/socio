// Types for npm-pin.mjs (CB-326).
export interface NpmPin {
    version: string;
    package: string;
    url: string;
    sha512: string;
    integrity: string;
    fetched: string;
    verified: string;
}
export interface NpmPinTarget {
    id: string;
    label: string;
    path: string;
    arg: string;
}
export const NPM_REGISTRY: string;
export const NPM_PINS: NpmPinTarget[];
export function parseNpmPin(text: string, label?: string): NpmPin;
export function dockerfileNpm(dockerfile: string, arg: string): { version: string; url: string };
export function checkNpmPin(pinText: string, dockerfile: string, target: { label: string; arg: string }): NpmPin;
