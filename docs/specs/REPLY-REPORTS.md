# AI reply reports: the client contract (CB-382)

A workspace whose admins turned on **Share AI reply reports with Ingenio** sends each thumbs-down
on a socio's reply, with the person's confirmation, to Ingenio's reports collector. This page is
the contract between the server and its clients (web and mobile). The collector's side is
`docs/specs/CLOUD-SERVICES-PROTOCOL.md`; what leaves the workspace is in SECURITY.md, "AI reply
reports".

Owner decisions (2026-11-26): admins only, never Ingenio for a customer; a reason picker; a
confirmation every time; a sent report stays at Ingenio for its year; in a room, the answered
message goes too, marked as another person's.

## 1. Is sharing on?

`GET /api/workspace` (the payload every client already reads and caches per workspace) carries:

```ts
replyReports: { sharing: true; consent: string } | null;
```

- `null`: sharing is off, or this server can't share (no cloud connection, or the issuer didn't
  grant `reports:write`). Clients show a plain thumbs-down: no reason picker, no confirmation.
- `consent`: an opaque id for the current consent (each time an admin turns sharing on, it
  changes). Clients send back the one they showed the confirmation for (§3).

The type is `ReplyReportsState` in `@socio/shared/chat/reply-reports`.

## 2. What the confirmation says

`@socio/shared/chat/reply-reports` exports the text, so web and mobile say the same thing:

- `REPORT_CONFIRMATION.title`, `.body` (what goes to Ingenio and what doesn't), `.confirm`,
  `.cancel`.
- `REPORT_CONFIRMATION.byOther`: the extra line when the message the reply answered was written by
  someone other than the person reacting ("…'s message goes too").
- `REPORT_REASONS`: `offensive`, `harmful`, `wrong`, `other`, each with its label.
- `REPORT_NOTE_MAX = 1000`, counted in Unicode code points (`[...note].length`), after trimming.

**Which message a reply answered** (`answeredMessage()`, the same module): the nearest
`user` message before the reply in the conversation's stored messages. Its author is that
message's sender (`senderOf`). `promptByOther` is true exactly when that author isn't the person
reacting. A client that has the transcript computes it with the same function; online clients may
ask instead:

`GET /api/conversations/:id/messages/:messageId/report` → `{ sharing: boolean, consent?: string,
promptByOther: boolean }` (404 as for reactions).

## 3. Reporting rides on the thumbs-down

One request, one write: the existing

`PUT /api/conversations/:id/messages/:messageId/reactions/down`

takes an optional JSON body:

```json
{ "report": { "reason": "offensive", "note": "optional", "consent": "<replyReports.consent>" } }
```

- No body, or no `report`: a plain thumbs-down, as today.
- `reason`: one of `REPORT_REASONS`, else 400. `note`: optional, at most 1,000 code points after
  trimming, else 400. Unknown fields: 400.
- A `report` on any kind other than `down`: 400.
- The thumbs-down is stored whatever happens to the report. The response is the reactions view as
  today, plus:

```ts
report?: 'queued' | 'already' | 'not-sharing' | 'consent-changed';
```

  - `queued`: confirmed and queued for Ingenio.
  - `already`: this person's report on this reply exists (a retry, or a second PUT): nothing new.
  - `not-sharing`: sharing is off now (or the server can't share): a plain thumbs-down; the reason
    and note are dropped, not kept.
  - `consent-changed`: `consent` isn't the current one (sharing was turned off and on again since
    the client showed the confirmation): a plain thumbs-down; nothing is reported.

  None of these is an error, so an offline outbox sending later never retries or shows a failure.

Each person's report on a reply is one report: a unique key on (conversation, message, person).

## 4. What a client shows afterwards

`GET /api/conversations/:id/reactions` adds, for the reader's own reactions:

```ts
messages[id].report?: 'queued' | 'shared' | 'failed';
```

`shared` shows as **Shared with Ingenio**. `failed`: it could not be sent (refused, or unsent for
7 days); admins see the count on the Cloud connection card.

## 5. Removing the thumbs-down

`DELETE …/reactions/down` answers, besides the view:

```ts
report?: 'withdrawn' | 'kept';
```

- `withdrawn`: it hadn't been sent; it's deleted and never will be.
- `kept`: it was already sent. It stays at Ingenio for its year (owner, 2026-11-26). Clients
  warn before removing a thumbs-down whose `report` is `shared`: "Removing it doesn't recall the
  report."

## 6. Admins

`GET /api/cloud/reply-reports` (admins): `{ available: boolean, sharing: boolean, consent?:
string, since?: number, by?: string, queued: number, failed: number }`.

`PUT /api/cloud/reply-reports { sharing: boolean }` (admins; 409 when `available` is false).
Turning it on records who, when and the consent text's version in the workspace audit, and makes
a new `consent`. Turning it off deletes every queued, unsent report.
