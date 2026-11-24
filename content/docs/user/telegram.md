---
title: 'Telegram'
description: 'Link your account, use commands and buttons in direct messages, and tell team topics from topics linked to a room.'
---

Telegram is available when your operator has configured the team's bot. You link your own app account so the bot knows which person it acts for. A Telegram display name or username alone does not establish that identity.

## Link your account

Open **Telegram** in the app and choose **Link Telegram**. Open the bot link and press **Start**. The link is one-use and expires after ten minutes. An unlinked person is asked to link before work runs. Unlink from the same account controls when you no longer want the connection.

Link from the correct signed-in app account: redeeming a new link can move that Telegram identity to the newly linked user. Do not forward your link to another person. Where configured, a linked account can also receive one-time sign-in links through the bot; those links are credentials too.

## Direct messages and team topics

Direct messages are private conversations of the linked person and can be continued in the app. Forum topics are team conversations. In Telegram, who can read a topic depends on the group's membership and settings. Readers may include group members who have never linked an account to Socio; linking controls how the bot acts for you, not who can read the Telegram group.

Socio's app view is separate: it shows a group's team conversations marked **Team** to app users recorded as participants after speaking in that group through their linked Telegram account. Speaking in a topic linked to a room doesn't count. These transcripts are read-only in the app; continue the team exchange in Telegram. A topic linked to a room is different: see [Topics linked to a room](#topics-linked-to-a-room).

When Rooms are on, someone who reads a team topic can select **Make this topic a room…** under its transcript. That makes a new room with them as its admin, linked to the topic once they send the code there as an admin of the group (as below). The team transcript stays as it is, read-only for the people who read it now. The room starts empty, and nobody joins it until they accept an invitation.

In a group, mention or reply to the bot to address it. Commands can include the bot name, such as `/help@yourbot`; commands intended for another bot are ignored. Use `/help` for the commands available to you. Telegram photos and documents become the sender's attachments in Socio's personal data space.

## Work in a direct message

A direct message with the bot works like a chat in the app. Type `/` to open Telegram's command menu. It lists the bot's own commands first, then every chat skill. Telegram does not allow hyphens in commands, so a skill such as `/grill-me` is `/grill_me` there. A skill that stays on, such as `/grill_me`, stays on for your next messages until you send `/done`, as in the app.

These commands are answered by the bot itself. They never reach a socio and never start a turn:

| Command     | What it does                                                                                               |
| ----------- | ---------------------------------------------------------------------------------------------------------- |
| `/new`      | Starts a new conversation with the same socio. Earlier conversations stay in the app.                      |
| `/socio`    | Shows the socios you can use as buttons, with the current one checked. `/socio Name` switches by name.     |
| `/stop`     | Stops the answer in progress, like **Stop** in the app. Messages you sent after it still get their answer. |
| `/memories` | Shows the memories your socios proposed, each with **Keep** and **Turn down**.                             |
| `/jobs`     | Shows how your jobs that run until done are doing, and how the latest ones ended.                          |
| `/help`     | Lists the skills and these commands.                                                                       |

Switching the socio, like `/new`, starts a new conversation. Neither works while an answer is in progress: send `/stop` first or wait for it.

Some things that appear as cards in the app appear as buttons in Telegram:

- **Approvals.** When a socio asks for your approval, the bot sends you a direct message with the request, its details and **Approve** and **Deny** buttons. It also links to the request in the app. After you decide, by button or in the app, the socio carries on in the conversation that asked.
- **Proposed memories.** When a socio proposes to remember something about you during a direct message, the bot shows it after the answer with **Keep** and **Turn down**. Nothing is remembered until you keep it. You can review, edit or forget memories in **Memories** in the app at any time.
- **Reactions.** React with 👍 or 👎 to a socio's answer to give it the same quick feedback as the app's reactions. Other emoji are only Telegram reactions.
- **Job progress.** A job that runs until done and was started from your direct message keeps one progress message there, updated as its batches finish. When the job ends, the socio tells you how it went.

Only you can use the buttons on messages the bot sent you. Pressing them from another Telegram account does nothing. The bot's own commands, buttons and reactions are for direct messages only. Group chats and forum topics work as described below.

## Topics linked to a room

A forum topic can be linked to a [room](/docs/rooms). Then it is where the room's socio works in the group. Room members talk to it there by mentioning the bot, replying to it, or with a skill command that names it, such as `/compact@yourbot`. A bare `/compact` in a group is for no bot in particular, so the bot ignores it. Each message is a room turn as the member who sent it, and the socio's reply is posted in the topic. In the app, the room shows the same messages with who wrote each.

The socio answers only room members there. If you aren't in the room, or your Telegram account isn't linked, the bot tells you once and does nothing with your messages: they aren't sent to the socio, stored in the room, or added to someone else's turn. Ask a room admin to invite you. The room's admins can see who the bot didn't answer.

To link a topic, you must be an admin of the room and of the Telegram group:

1. In the app, open the room's **⋯** menu and select **Telegram topic**.
2. Read who will see the topic, check **I understand who reads the topic**, then select **Get a code**.
3. In the Telegram topic, from your linked account, send the command shown, such as `/bind@yourbot Ab12…`. Group admins also find **/bind** in Telegram's command menu. The code works once, for 10 minutes, only from your account.

The bot confirms in the topic. A topic links to one room, and a room to one topic. **Unlink topic** in the same dialog, or archiving the room, unlinks it, and the topic then answers no one. To link it again, get a new code.

Messages written in the app stay in the app. They are not posted to the topic.

## Use team context carefully

Treat a team topic as material for everyone who can read it in Telegram, not just the people linked to Socio. Do not paste private account links, personal files or credentials there. A socio's turn acts for the linked speaker, subject to that person's permissions. Some memory is used only when explicitly allowed in team chats.

If the bot does not answer, first check your link and whether you addressed it. An admin can inspect the bot's connection and allowed groups. Avoid repeated messages while a run is active: Telegram does not use the web chat's editable queued-message feature. Read [privacy](/docs/privacy) and [chats](/docs/chats) for the corresponding browser behavior.
