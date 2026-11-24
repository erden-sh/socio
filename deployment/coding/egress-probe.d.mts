// Types for egress-probe.mjs (CB-239).
export interface ProbeReport {
    probe: 'socio-egress-probe';
    v: 1;
    resolved: string[];
    reached: string[];
    tunnel: boolean;
}
export const OUTSIDE_NAMES: string[];
export const PUBLIC_RESOLVERS: string[];
export const PUBLIC_TARGETS: Array<[string, number]>;
export const GATEWAY_PORTS: number[];
export function tcpOpens(host: string, port: number, ms?: number): Promise<boolean>;
export function tunnelOpens(proxy: string, port?: number, ms?: number): Promise<boolean>;
export function runProbe(options: {
    gateway?: string;
    proxy?: string;
    lookup?: (name: string) => Promise<unknown>;
    resolveWith?: (server: string, name: string) => Promise<unknown>;
    opens?: (host: string, port: number) => Promise<boolean>;
    tunnel?: (proxy: string) => Promise<boolean>;
}): Promise<ProbeReport>;
