-- The APNs provider token, shared by every isolate of the relay: one row per APNs key,
-- holding the signed JWT and its `iat` (Unix seconds), replaced about every 50 minutes. Apple
-- answers 429 TooManyProviderTokenUpdates when a key's token changes more often than every 20
-- minutes, which isolates signing their own tokens could do. `key` is a hash of the team id, key
-- id and key fingerprint, but the stored JWT carries the key id (`kid`) and team id (`iss`) in the
-- clear. The private key is never stored; the JWT is a bearer valid for at most an hour.
CREATE TABLE apns_provider_tokens (
    key TEXT PRIMARY KEY,
    jwt TEXT NOT NULL,
    issued_at INTEGER NOT NULL
);
