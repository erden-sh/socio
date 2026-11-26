# AI reply reports: the client contract (CB-382)

A workspace whose admins turned on **Share AI reply reports with Ingenio** sends each thumbs-down
on a socio's reply, with the person's confirmation, to Ingenio's reports collector. This page is
the contract between the server and its clients (web and mobile). The collector's side is
`docs/specs/CLOUD-SERVICES-PROTOCOL.md`; what leaves the workspace is in SECURITY.md, "AI reply
reports".

Owner decisions (2026-11-26): admins only, never Ingenio for a customer; a reason picker; a
confirmation every time; a sent report stays at Ingenio for its year; in a room, the answered
message goes too, marked as another person's; the socio goes as a hashed id, never its name
(Q11): a per-deployment HMAC of the socio's id, like `threadHash`, under a key of its own label.

Telegram (CB-145) has no confirmation screen, so a thumbs-down there is always a plain one.
Removing a thumbs-down there withdraws a report as anywhere else (§5).

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
  `.cancel`; `.shared` ("Shared with Ingenio", §4) and `.removeShared` (the warning of §5).
- `REPORT_CONFIRMATION.byOther`: the extra line when the message the reply answered was written by
  someone other than the person reacting: `"{author}'s message goes to Ingenio too."`
- The strings carry placeholders (`{socio}`, the socio's name; `{author}`, the other person's
  name) that clients fill in with `fillReportText(template, values)`; none is a prebuilt sentence.
  `reportTextPlaceholders(template)` lists a string's placeholders.
- `REPLY_REPORTS_SETTING.label` and `.body`: the admins' switch and what it says.
- `REPLY_REPORTS_TEXT_VERSION`: the version of these texts, which the audit records (§6).
- `REPORT_REASONS`: `offensive`, `harmful`, `wrong`, `other`, each with its label.
- `REPORT_NOTE_MAX = 1000`, counted in Unicode code points (`reportNoteLength(note)`,
  `[...note.trim()].length`), after trimming.

**Which message a reply answered** (`answeredMessage(messages, replyId, owner)`, the same module):
the nearest `user` message before the reply in the conversation's stored messages. Its author is
that message's sender (its `socioSender` metadata, as `senderOf` stamps it), or, for a message
stored without one, the conversation's owner (`owner`; a room's owner is `room:<id>`, never a
person). `promptByOther(answered, reactorId)` is true exactly when that author isn't the person
reacting. A client that has the transcript computes it with the same functions; online clients may
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

- `queued`: confirmed and queued for Ingenio. This also holds when the person's thumbs-down was
  already there without a report: the report is made then.
- `already`: this person's report on this reply exists, queued, shared or failed (a retry, or a
  second PUT): nothing new.
- `not-sharing`: sharing is off now (or the server can't share): a plain thumbs-down; the reason
  and note are dropped, not kept.
- `consent-changed`: `consent` isn't the current one (sharing was turned off and on again since
  the client showed the confirmation): a plain thumbs-down; nothing is reported.

None of these is an error, so an offline outbox sending later never retries or shows a failure.
The server checks them in this order: sharing, consent, an existing report.

Each person's report on a reply is one report: a unique key on (conversation, message, person),
over the reports that still exist. A withdrawn report is deleted (§5), so a later thumbs-down with
a report files a new one, with a new report id; a sent or failed one stays, and a new report on
that reply answers `already`.

`PUT …/reactions/up` replacing the person's thumbs-down removes its report as `DELETE …/down` does
(§5), and its response carries the same `report: 'withdrawn' | 'kept'`.

## 4. What a client shows afterwards

`GET /api/conversations/:id/reactions` adds, for the reader's own reactions:

```ts
messages[id].report?: 'queued' | 'shared' | 'failed';
```

It is there only while the reader's own thumbs-down on that reply is (`mine` includes `down`).

`shared` shows as **Shared with Ingenio**. `failed`: it could not be sent (refused, or unsent for
7 days). `failed` is final: the server never sends it again, and the person can't act on it;
admins see the count on the Cloud connection card.

## 5. Removing the thumbs-down

`DELETE …/reactions/down` answers, besides the view:

```ts
report?: 'withdrawn' | 'kept';
```

- `withdrawn`: it hadn't been sent; it's deleted and never will be.
- `kept`: it was already sent, or a send of it was in flight, so it may have reached Ingenio. It
  stays at Ingenio for its year (owner, 2026-11-26). Clients warn before removing a thumbs-down
  whose `report` is `shared` (`REPORT_CONFIRMATION.removeShared`): "Removing it doesn't recall the
  report."
- No `report`: there was none, or it had failed (it never went, and stays for the admins' count).

The same holds whichever way the thumbs-down goes: the web, the app, Telegram, or a thumbs-up in
its place (§3).

## 6. Admins

`GET /api/cloud/reply-reports` (admins; 403 for members): `{ available: boolean, sharing: boolean,
consent?: string, since?: number, by?: string, queued: number, failed: number }`
(`ReplyReportsAdminView`). `available`: the cloud connection is up (or briefly paused) and the
issuer grants `reports:write`. `sharing` is the admins' setting as stored; reports go only while
`available` is true too. `consent`, `since` and `by` (the admin's user id) are there while sharing
is on.

`PUT /api/cloud/reply-reports { sharing: boolean }` (admins; anything else in the body: 400).
Turning it on while `available` is false: 409; turning it off always works. Turning it on records
who, when and the text's version (`REPLY_REPORTS_TEXT_VERSION`) in the workspace audit, and makes a
new `consent`; turning it on while it is on changes nothing. Turning it off deletes every queued,
unsent report (one a send holds at that moment goes only if that send succeeds), and is in the
audit too.
