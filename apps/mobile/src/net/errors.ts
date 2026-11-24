// What the app's requests fail with, besides an HTTP answer (which comes back
// as a Response, whatever its status). Plain Error subclasses with a `cause`
// set by hand, since nothing here may count on the engine's Error options.

/** The URL isn't on the workspace's origin, so nothing was sent. */
export class OutsideOriginError extends Error {
    override name = 'OutsideOriginError';

    constructor(
        readonly url: string,
        readonly origin: string,
    ) {
        super(`${url} isn't on ${origin}: the request wasn't sent.`);
    }
}

/**
 * The server answered with a redirect. A workspace request never follows one
 * (`redirect: 'error'`), since its cookies go only to the workspace's origin.
 */
export class RedirectRefusedError extends Error {
    override name = 'RedirectRefusedError';

    constructor(
        readonly url: string,
        cause?: unknown,
    ) {
        super(`${url} answered with a redirect, which a workspace request never follows.`);
        this.cause = cause;
    }
}

/**
 * No answer, or one that broke off: offline, DNS, TLS, a dropped connection,
 * a body cut short (`readText`). `serverAway` counts it as the server being away.
 */
export class NetworkError extends Error {
    override name = 'NetworkError';

    constructor(
        readonly url: string,
        cause?: unknown,
    ) {
        super(`No answer from ${url || 'the server'}.`);
        this.cause = cause;
    }
}

/**
 * The request was stopped: its workspace closed (a switch, a sign-out), or its
 * caller gave up. Named `AbortError` as fetch's own is, which expo/fetch doesn't
 * throw (it rejects with a plain FetchError).
 */
export class AbortedError extends Error {
    override name = 'AbortError';

    constructor(
        readonly url: string,
        cause?: unknown,
    ) {
        super(`The request to ${url || 'the server'} was stopped.`);
        this.cause = cause;
    }
}
