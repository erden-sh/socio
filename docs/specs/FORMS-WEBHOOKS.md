# Forms webhooks: the receiver contract

Status: **stable, spec v1.** Copied from the Forms plugin, which is the source of truth for the sending side.

This is the contract every receiver of webhooks from the Forms plugin builds against: a Socio plugin (an events plugin, for example), Zapier, a request bin, anything. `packages/app-sdk` implements the receiving side (`verify`, `sign` and `receiver` in `@socio/app-sdk/webhooks`; see `packages/app-sdk/README.md`).

**Forms uses [Standard Webhooks](https://www.standardwebhooks.com) (spec v1):** its three headers, its signed content, its `v1` HMAC-SHA256 signature, its `whsec_` secret format and its multiple-signature rotation. You can verify with an existing library (`standardwebhooks` on npm, PyPI, Go and more) instead of writing your own. The body follows its recommended `type`, `timestamp`, `data` envelope. Forms adds one event header and defines the body's `data`.

## 1. Request

- `POST` to the destination URL exactly as the admin entered it. HTTPS only.
- `content-type: application/json`, UTF-8. The body is sent byte for byte as signed: **verify the raw bytes before you parse them.**
- `user-agent: socio-forms-webhooks/1`.
- Redirects are not followed. A `3xx` counts as a failure.
- Timeout: 15 seconds for the whole response.

## 2. Headers

| Header              | Value                                                                                                 |
| ------------------- | ----------------------------------------------------------------------------------------------------- |
| `webhook-id`        | The delivery id, `msg_<ULID>`. One per event and destination. The same on every retry and redelivery. |
| `webhook-timestamp` | Unix seconds when this attempt was signed.                                                            |
| `webhook-signature` | A space-separated list of `v1,<base64 signature>`, one per active secret.                             |
| `x-forms-event`     | The event type, the same as the body's `type`.                                                        |
| `x-forms-attempt`   | The attempt number, from 1. For logs only; not signed.                                                |

## 3. Signature

```
key            = base64_decode(secret without the "whsec_" prefix)
signed_content = webhook_id + "." + webhook_timestamp + "." + raw_body
signature      = base64(HMAC_SHA256(key, utf8(signed_content)))
header entry   = "v1," + signature
```

- Secrets are `whsec_` plus the standard base64 (with padding) of 32 random bytes. An admin may also paste a `whsec_` secret your system gave them; Forms accepts keys of 24 to 64 bytes.
- Compute the signature with each secret you hold, and accept when any `v1,` entry matches, comparing in constant time. Ignore entries with another version prefix.
- Refuse a `webhook-timestamp` more than **5 minutes** from your clock, in either direction. That is the replay window.

## 4. Body

```json
{
    "type": "form.submitted",
    "timestamp": "<ISO 8601 UTC, ms>",
    "data": {
        "submissionId": "sub_…",
        "form": { "id": "frm_…", "slug": "…", "version": 3, "title": "…" },
        "submittedAt": "<ISO 8601 UTC, ms>",
        "test": false,
        "fields": { "<key>": "<value>", … },
        "labels": { "<key>": "<label>", … },
        "options": { "<choice key>": { "<option key>": "<option label>" } }
    }
}
```

- `type` is one of:
    - `form.submitted`: a visitor sent the form.
    - `webhook.test`: the admin pressed **Send test**. `data` has the same shape, with `test: true`, `submissionId: null`, and each field set to a sample value of its type. Answer `2xx` and store nothing.
- `timestamp` is when the event happened (the submission's time). It does not change on retries; `webhook-timestamp` does.
- `fields` holds **every** field key of that form version, always. An optional field left empty is `null`. A `checkbox` is always `true` or `false`. Keys never change meaning or type across versions.
- `labels` maps each field key to its label in that version. `options` maps each choice field's option keys to labels. Key on `fields`; use `labels` and `options` for display only.
- No IP address, user agent, cookie or Turnstile data is ever in the body.
- **Ignore unknown properties.** Forms adds properties without a version change; it never removes or retypes one. A breaking change would be a new event type.
- The Forms plugin publishes a JSON Schema of this body with its own code.

### Field values

| Field type        | Value in `fields`                                 |
| ----------------- | ------------------------------------------------- |
| `short_text`      | string, trimmed, at most 500 characters           |
| `long_text`       | string, trimmed, newlines as `\n`, at most 10,000 |
| `email`           | string, trimmed, with exactly one `@`             |
| `phone`           | string as typed, trimmed                          |
| `url`             | string, `http` or `https` only                    |
| `number`          | number                                            |
| `date`            | string `YYYY-MM-DD`                               |
| `single_choice`   | the option's key, a string                        |
| `multiple_choice` | array of option keys, in option order             |
| `checkbox`        | boolean                                           |
| `hidden`          | string from a query parameter, at most 500        |

Keys match `^[a-z][a-z0-9_]{0,62}$`.

## 5. Success, retries and their cap

- **Success:** any `2xx` within 15 seconds. Your answer's body is ignored and not stored.
- **Stop at once:** `410 Gone`. The delivery fails with `gone`, and the admin sees the destination flagged.
- **Retry:** everything else: other `4xx`, `5xx`, `3xx`, a timeout, a DNS, TLS or connection error.
- **Schedule,** counted from the first attempt, each delay with up to 10% jitter:

| Attempt | Delay after the previous one | About when |
| ------- | ---------------------------- | ---------- |
| 1       | immediately                  | 0          |
| 2       | 1 minute                     | 1 min      |
| 3       | 5 minutes                    | 6 min      |
| 4       | 30 minutes                   | 36 min     |
| 5       | 2 hours                      | 2.6 h      |
| 6       | 6 hours                      | 8.6 h      |
| 7       | 12 hours                     | 20.6 h     |
| 8       | 24 hours                     | 44.6 h     |

- **Cap:** 8 attempts, then the delivery fails. An admin can **Redeliver** it, which makes one new attempt with the same `webhook-id`.
- A `429` or `503` with `Retry-After` (seconds or an HTTP date) is honored when it asks for longer than the next step, up to 24 hours. It never adds attempts.
- Disabling a destination stops its pending retries. Enabling it again does not resume them; the admin redelivers.

## 6. Idempotency

- `webhook-id` is the key. Retries and redeliveries reuse it. Store the ids you have processed (for at least 7 days) and answer `2xx` without reprocessing a repeat.
- One submission sent to two destinations has two `webhook-id`s and one `submissionId`. If you sit behind two destinations, dedupe on `submissionId`.
- Delivery order is not guaranteed. Use `data.submittedAt` for order.

## 7. Test delivery

**Send test** posts a `webhook.test` event to that one destination, signed with every active secret, on the normal schedule. It shows in the admin's delivery log like any delivery.

## 8. Secret rotation

- A destination has one or two active secrets. While it has two, every delivery carries two `v1,` entries, so you can switch whenever you are ready.
- **Rotate secret** makes a new secret, shows it to the admin once, and adds it as the second. **Retire old secret** removes the older one.
- Neither the plugin nor the Worker ever shows a secret again. A lost secret is replaced by rotating.

## 9. Worked example (a test vector)

Test secret (never use it for real): `whsec_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=`. Its key is the 32 bytes `0x00, 0x01, …, 0x1f`.

Headers:

```
webhook-id: msg_01JD7Q4W9A7G3K5P8R2S6U4V0X
webhook-timestamp: 1795100645
webhook-signature: v1,L6yTYohs7AW+2OKv1bdkxrlwsucxuPOFbobw709B2fc=
x-forms-event: form.submitted
x-forms-attempt: 1
content-type: application/json
```

Body, exactly these 767 bytes on one line (SHA-256 `8b8d0789a7e7304693befbb64cd0d987111dfd614289ed3ca16c87c21c1e0213`):

```text
{"type":"form.submitted","timestamp":"2026-11-19T15:04:05.120Z","data":{"submissionId":"sub_01JD7Q4W8M2T5V9X3B6N1C0RKE","form":{"id":"frm_01JD7NZK3H8F2Q6W4T9Y5B1M7A","slug":"event-inquiry","version":3,"title":"Event inquiry"},"submittedAt":"2026-11-19T15:04:05.120Z","test":false,"fields":{"full_name":"Ana Example","email":"ana@example.com","guests":40,"event_date":"2027-02-14","interest":["private_event","catering"],"consent":true,"notes":null},"labels":{"full_name":"Your name","email":"Email","guests":"How many guests?","event_date":"Event date","interest":"What are you planning?","consent":"You may contact me about this request","notes":"Anything else?"},"options":{"interest":{"private_event":"Private event","catering":"Catering","workshop":"Workshop"}}}}
```

Steps:

1. Strip `whsec_` and base64-decode the rest: 32 bytes, `00 01 02 … 1f`.
2. Build `msg_01JD7Q4W9A7G3K5P8R2S6U4V0X.1795100645.` followed by the raw body bytes.
3. HMAC-SHA256 that with the key. Base64 the 32-byte result: `L6yTYohs7AW+2OKv1bdkxrlwsucxuPOFbobw709B2fc=`.
4. Compare it, in constant time, with each `v1,` entry of `webhook-signature`. It matches.
5. Check `1795100645` (2026-11-19 15:04:05 UTC) is within 5 minutes of now. Then check `webhook-id` is new, process, and answer `2xx`.

In Node with the library: `new Webhook(secret).verify(rawBody, headers)` from `standardwebhooks`. The Forms plugin's tests and this repository's `tests/app-sdk-webhooks.test.ts` check this exact example. Copy it into your receiver's tests with a fixed clock.

Note: the example's `webhook-id` is illustrative and contains a `U`, which a real ULID never does. Don't validate `webhook-id` as a ULID; treat it as an opaque string.
