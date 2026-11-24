export function completion(
    delta: Record<string, unknown>,
    /** `null`: the stream ends without one, as a cut-off stream does. */
    finishReason: string | null = 'stop',
    /** Chat Completions `usage`, on the finish chunk. */
    usage?: Record<string, unknown>,
) {
    return completionStream([delta], finishReason, usage);
}

/** A streamed completion of these deltas, one chunk each, then the finish chunk. */
export function completionStream(
    deltas: Array<Record<string, unknown>>,
    finishReason: string | null = 'stop',
    usage?: Record<string, unknown>,
) {
    const chunk = (delta: Record<string, unknown>, finish: string | null) => ({
        id: 'completion',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'custom-model',
        choices: [{ index: 0, delta, finish_reason: finish }],
    });
    const chunks = [
        ...deltas.map((delta) => chunk(delta, null)),
        { ...chunk({}, finishReason), ...(usage ? { usage } : {}) },
    ];
    return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n', {
        headers: { 'Content-Type': 'text/event-stream' },
    });
}
