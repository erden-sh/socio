/**
 * What a model is resolved for. `chat` (web and Telegram) and `scheduled`
 * turns are the user's own and may run on their bring-your-own connection,
 * as do `approval` reviews (a decision model deciding a request in the
 * user's place); the rest is workspace work and runs on the default shared
 * backend only.
 */
export type InferencePurpose =
    | 'chat'
    | 'scheduled'
    | 'title'
    | 'learning'
    | 'approval'
    /** A long chat's running notes, on the shared model (CB-137). */
    | 'summary'
    /** The rest of a turn whose person's own model was busy (CB-140). */
    | 'fallback'
    /**
     * A coding session's model calls through the model gateway (CB-239):
     * one listed shared backend and model, looked up by id
     * (`InferenceService.codingEndpoint`), never through `resolve`. A
     * person's own plan serves only their own coding sessions, asked for
     * explicitly (`personalCodingTransport`).
     */
    | 'coding';
