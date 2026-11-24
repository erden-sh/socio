/**
 * A plugin tool's or data route's refusal: a sentence the caller can act
 * on, and the HTTP status it maps to. Never a stack.
 */
export class PluginToolError extends Error {
    constructor(
        message: string,
        readonly status: 400 | 403 | 404 | 409 = 400,
    ) {
        super(message);
    }
}
