import { McpConnectionError } from './contract.js';

/** A refused request: its message, and the HTTP status to answer (400 unless given). */
export const mcpError = (message: string, status = 400) => new McpConnectionError({ message, status });

export const mcpAssert: (value: unknown, message: string, status?: number) => asserts value = (
    value,
    message,
    status,
) => {
    if (!value) {
        throw mcpError(message, status);
    }
};
