// Types for the do-nothing @segment/analytics-node (see index.cjs). Loose on
// purpose: callers compile against it, and nothing is sent.
type Callback = (err?: unknown, ctx?: unknown) => void;
type Params = Record<string, unknown>;

export declare class Analytics {
    constructor(settings: { writeKey: string } & Record<string, unknown>);
    ready: Promise<void>;
    get VERSION(): string;
    alias(params: Params, callback?: Callback): void;
    group(params: Params, callback?: Callback): void;
    identify(params: Params, callback?: Callback): void;
    page(params: Params, callback?: Callback): void;
    screen(params: Params, callback?: Callback): void;
    track(params: Params, callback?: Callback): void;
    flush(options?: { timeout?: number; close?: boolean }): Promise<void>;
    closeAndFlush(options?: { timeout?: number }): Promise<void>;
    register(...plugins: unknown[]): Promise<void>;
    deregister(...pluginNames: string[]): Promise<void>;
    on(event: string, listener: (...args: unknown[]) => void): this;
    once(event: string, listener: (...args: unknown[]) => void): this;
    off(event: string, listener: (...args: unknown[]) => void): this;
    emit(event: string, ...args: unknown[]): boolean;
}
export declare const isNoop: true;
export default Analytics;
