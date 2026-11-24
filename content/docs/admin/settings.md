---
title: 'Settings and people'
description: 'Separate workspace policy, personal choices and operator-only platform controls.'
---

Settings groups workspace controls separately from a person's Account controls. Your role and configured services determine what appears. A missing control may be unavailable by design rather than a broken page.

## Workspace and account settings

**General** contains the shared controls and limits the team permits admins to change: pausing work, research and memory behavior, scheduling and job limits, data quotas, notification limits, backup scheduling and other configured modules. Read the control's explanation before changing it. Lowering a limit does not delete existing data and can prevent new work until usage falls below it. Two limits do delete: **Memory → Keep episodes for** (180 days unless set, or `EPISODE_RETENTION_DAYS`) removes each person's episodes of their own chats once they haven't come up for that long; people can delete theirs sooner on Memories. **Memory → Keep retired Space memory for** (365 days unless set, or `SPACE_MEMORY_RETENTION_DAYS`) removes what a Space's shared memory no longer uses (earlier versions, proposals turned down or taken back, retired entries) after that long; entries in use stay until a Space editor retires them. **Calls** chooses whether voice calls run on OpenAI's cloud service or on your own voice server, and which speech server reads self-hosted replies aloud; the card says whether calls can start with the choice in force. What people experience is in [Voice calls](/docs/voice-calls).

**People** (with its **Groups** and **Service accounts** tabs), **Chat skills**, **Deleted Spaces**, **Optional features** and **Early access** (and **In development** on an internal deployment) are administrative controls; see [Features and early access](/docs/admin/features) for the feature pages, and [Delete and restore Spaces](/docs/admin#delete-and-restore-spaces) for deleted Spaces. Account **Profile**, **Notifications**, **Inference**, **Archived chats**, **Connected agents** and **Telegram** apply to the signed-in person where available. Changing your own account connection does not set the workspace's shared model.

Only operators manage **Platform** inference backends. Environment model values seed the first backend once; later edits belong in Platform. A disabled or missing shared default affects background functions as well as people without a personal connection. Model selection and any fallback policy are explicit controls, not a guarantee that another provider will rescue a failed call.

## Add xAI Grok as a shared backend

xAI's API is OpenAI-compatible, so an operator adds Grok on **Platform** with **Add backend**, like a self-hosted server:

| Field    | Value                                                                                                            |
| -------- | ---------------------------------------------------------------------------------------------------------------- |
| Base URL | `https://api.x.ai/v1`                                                                                            |
| Model    | The xAI model id exactly as xAI's console lists it, for example `grok-4`. Ids change; check the console's list.  |
| API key  | An xAI API key. It is write-only and stored sealed; nobody can read it back. Treat it as a secret, never a note. |

Set **The model takes images**, **Context window** and **Completion tokens per turn** to match the model's published limits, then use **Test** and, if Grok should serve everyone, **Make default**. Each model is a separate backend.

Everything a turn sends goes to xAI under xAI's terms and is billed to the key's account, which everyone whose chats use the backend shares. People cannot connect a personal Grok key; this is a shared backend only.

## Work per message

Each message a person sends, and everything it starts (model rounds, tools, an approval it waits for), is bounded as one piece of work. **General → Work per message** sets the bounds for every chat and Telegram topic:

| Limit                      | Default   | What happens at it                                                                                                                                                           |
| -------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tokens per message         | 2,000,000 | Model tokens in and out, retries and notes included. Each model request reserves its share first, so one that would pass the limit is not sent; the socio stops and says so. |
| Messages a minute per chat | 20        | Counts everyone's messages in a chat or topic, queued ones included. More are turned away with a note to wait; the text stays in the message box.                            |
| Spend per message          | none      | Applies only where the model reports its cost. Where it does not, the spend is unknown and tokens and time still bound the work. 0 sets no cap.                              |
| Handoffs per message       | 4         | In a room with several socios, how often the work may pass between them. 0 turns handoffs off; a room admin may lower it for their room.                                     |

The message's time is the **Turn time limit** and its queue the **Queued messages per chat** limit, both under **Socio replies**. Time spent waiting for an approval does not count toward it. A change applies to the next message: work already running keeps the limits it started with. Each limit is enforced by the server, and a restart keeps what a message had used.

## Rooms (preview)

Rooms are shared conversations: several people and a company socio in one chat. They are a preview. **General → Rooms** turns them on for the workspace, over the server's `ROOMS_ENABLED`; they are off by default. With them on, everyone gets **Rooms** in the sidebar, where they create rooms, share a chat as one and accept invitations ([Rooms](/docs/rooms)); with them off, none of that shows.

- People join a room only by accepting an invite, which tells them they will read its whole history. An invite lapses after 7 days.
- A room's admins rename it, invite and remove people, change roles and archive it. A room always keeps an admin: the last one hands the role on before leaving, and if you deactivate a room's last admin, its earliest remaining member becomes its admin. A room with nobody active left is archived and kept.
- Your admin role gives you no access to a room's messages. You decide which company socios may answer in a room: the socios rooms asked for are listed under **General → Rooms**, each with **Let in**. You can take one out again from the Members panel of a room you are in.
- You can still read a room in **Operations**, as any chat: its heading names its people and socios, and its **Room audit** shows who joined, left, was invited, removed or refused, never what was said. Each view is written to the access log with the room, and opening a room turn's trace there also records who started it and which socio ran it.
- Turning Rooms off hides rooms and invitations from the app and makes every room read-only: a member who opens a room's link can still read it, and nothing new runs there until you turn it back on.

## Add and link people

**People** lists everyone who signs in: their role, whether they are active, invited or deactivated, when they were last active, how they sign in and what they can reach. Search and filter it by role and status; each person's other actions are in their row's **⋯** menu. A role change that takes something away asks first. Add a person with **Invite people**. If migrating an existing identity, choose the existing app user to link instead of creating a replacement identity. Conversations, Telegram links and other owned records depend on that stable mapping. Deliver password links privately; they are credentials. A Telegram sign-in link goes directly to the linked person's bot conversation rather than being exposed to an admin.

**Groups**, the People section's second tab, give people permissions beyond their role. Admins have every permission without a group. Create a group with **New group**, name it and choose its permissions (**Run code**, which lets people start coding sessions, is the only one for now), then add people from its card. Rename it or change its permissions with **Edit**, and remove it with **Delete**. Each change applies at once: someone you take out of the group, or whose group you delete, can't run code from their next try. A person's page lists their groups, and you can take them out of one there.

Sign-in methods and the allowlists are under **Access**, for admins, in person: they can narrow what the server's environment allows, never widen it. An account that is an admin by email can become a member when an admin takes the email off that list.

There are two roles, admin and member. Admins manage every account, and the server keeps at least one active admin. One admin is the **workspace owner**, marked **Owner** in People. Other admins can't demote, deactivate or remove the owner, sign the owner out or make the owner a password link. The owner can't demote or deactivate themselves, or leave, until they hand ownership over: open another active admin's page and choose **Make owner**, type their name and confirm it's you. The previous owner stays an admin, and every admin is told. Plan the replacement before removing a person's authority.

## Deactivate deliberately

Deactivation blocks sign-in and ends sessions. Its dialog shows what it will end before you confirm, keys first: a key that is a service account's only live key is flagged, with a link to make that account a new key first. It also revokes keys created by that person, ends app sessions, pauses their schedules and disconnects subscription and connected-agent access. Their documents, conversations and attributed work remain. Reactivation permits a new sign-in; it does not revive old sessions, keys, schedules or disconnected connections.

Prefer the People workflow while an authorized admin can sign in; it can reach live server state that a standalone command cannot. For account recovery or deployment secrets, ask whoever runs your deployment. Use [Socios administration](/docs/admin/socios), [Learning](/docs/admin/learning) and [service accounts](/docs/admin/service-accounts) for the relevant scope.
