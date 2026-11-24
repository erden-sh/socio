/**
 * A domain error as a tool's result (CB-185): its message for the model to
 * act on, and its HTTP status as the code the trace keeps (`http_404`),
 * which `resultOutcome` reads and the failure taxonomy sorts.
 */
export function toolError(error: { message: string; status: number }) {
    return { error: error.message, code: `http_${error.status}` };
}
