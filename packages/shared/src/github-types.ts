/** `owner/name` on GitHub. */
export const GITHUB_REPOSITORY = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/(?!\.\.?$)[A-Za-z0-9._-]{1,100}$/;
/** A branch name: plain segments, no `..`, `//`, `@{`, `.lock` or ends in `/` or `.`. */
export const GITHUB_BRANCH = /^(?!.*(?:\.\.|\/\/|@\{|\.lock(?:\/|$)|\/\.))[A-Za-z0-9_][A-Za-z0-9._/-]{0,199}(?<![/.])$/;

/**
 * `GET /api/github` (admins, CB-32, CB-325): the GitHub App coding
 * sessions' Git proxy and pull requests use. Each value is an admin's from
 * Settings over the environment's (`GITHUB_*`). The App's private key is
 * never sent back, only where the App comes from.
 */
export interface GitHubAppView {
    /** The repository whose owner "Connect GitHub" makes the App for. */
    repository: string | null;
    repositorySource: 'settings' | 'env' | null;
    /** Connected here ("Connect GitHub") or set in the environment. */
    app: {
        source: 'settings' | 'env';
        id: string;
        /** Its address on GitHub: `github.com/apps/<slug>`. */
        slug: string | null;
        owner: string | null;
    } | null;
    /** The App's installation, when recorded; otherwise found from each repository. */
    installation: { id: string; account: string | null } | null;
    /**
     * The App saved here can't be opened (its data key is gone): Disconnect,
     * then Connect GitHub, recovers.
     */
    unreadable: boolean;
    /** "Connect GitHub" needs APP_ORIGIN: GitHub sends the admin back there. */
    canConnect: boolean;
}

/** `PUT /api/github`: omitted keeps the value; null goes back to the environment's. */
export interface GitHubAppInput {
    repository?: string | null;
}

/** The connect flow's answers: where the browser goes next. */
export interface GitHubConnectNext {
    url: string;
}
