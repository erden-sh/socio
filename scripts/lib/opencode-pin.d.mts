// Types for opencode-pin.mjs (CB-239).
export interface OpencodePin {
    version: string;
    asset: string;
    sha256: string;
    url: string;
    fetched: string;
    verified: string;
}
export const OPENCODE_PIN_PATH: string;
export const OPENCODE_RELEASES: string;
export function parseOpencodePin(text: string): OpencodePin;
export function dockerfileOpencode(dockerfile: string): {
    version: string;
    url: string;
    asset: string;
};
export function checkOpencodePin(pinText: string, dockerfile: string): OpencodePin;
