---
title: 'Chats'
description: 'Start, steer and revisit conversations with your socios.'
---

## Give a socio a clear brief

Select a socio and start a conversation. Explain the result you want, the material it should use and any limits. A role name is a useful starting point, but it does not grant tools or access. A socio can use only the capabilities and Spaces available to it for you.

Conversation history belongs to its owner. Using the same workspace socio as a colleague does not put you in their private chat. Telegram team topics are a separate shared conversation type; see [Telegram](/docs/telegram). To share a conversation on purpose, use a [room](/docs/rooms).

## While a reply runs

The chat shows the reply and tool activity as it arrives. **Stop** asks Socio to stop the running turn. It cannot undo an action that already completed outside Socio. If an action's outcome is uncertain, check its status before asking for it again.

Each message, and the work it starts, has limits an admin sets: time, model tokens, and in some workspaces spend. When the socio reaches one it stops and the chat says which; send a new message to carry on, or ask for less at a time. A chat also takes only so many messages a minute; past that it asks you to wait a moment and keeps your text in the box.

The mic in the message box turns your speech into text for you to edit and send. When your server transcribes it, it detects the language you speak; if it keeps guessing wrong, pick yours under **Settings → Account → Profile → Dictation language** (Auto is the default). Self-hosted voice calls use the same choice.

You can write a follow-up while the socio works. Queued text appears with **Edit** and **Cancel** until it is taken. The socio reads it at a safe point after its current tool step, or on the following turn if that turn ends first. A queued message is not an immediate interruption of a running tool. Stopping a turn does not discard queued messages; edit or cancel them if you no longer want them sent. Attachments wait for the next message once the reply is done.

## Add material and reuse the result

Use the paperclip, drop or paste to attach material. Files go into your personal data space; attaching a file lets this conversation's socio read it. Images need a model with image support, and large or older images may appear as notes rather than image input. See [Data and media](/docs/data-media).

The save-to-page action creates a document from stored conversation text. Read the material before saving it into a [shared Space](/docs/spaces). A page keeps a reference to the source conversation, but that does not make another person's private chat readable.

## What socios remember of your chats

Your socios carry some of your own chats into your other chats. When a chat of yours gets long enough to be compacted (or you send `/compact`), the decisions, results, goals and open questions its notes keep, and what the chat was about, become **episodes**. A socio may bring a few that match your message into its reply, or search them when you mention an earlier conversation, and it says which chat one came from. Episodes are only ever used in your own chats: never in a Telegram team topic, a group or any chat with other people in it, and never in someone else's turn.

See, search and delete yours under **Memories → From your chats**. Deleting one, or all, removes them from the workspace at once; backups keep them until they age out. An admin sets how long they are kept after they last came up (180 days unless changed), and turning memory off, for the workspace or a socio, stops new ones and their use. Episodes are not memories: nothing you approved is changed, and an episode is never used in team chats even when your memories are.

## Commands and problems

Use `/help` for available chat commands and installed skills. `/compact` tidies a long conversation. Some skills apply to one message; others stay active until `/done` or **End**. A skill supplies instructions and does not add permissions or install missing programs.

For an error, note the time and what the chat reported. Check whether an approval is pending, a model connection is unavailable or the workspace is paused. Report a reproducible problem on [Improvements](/docs/improvements), leaving credentials and confidential chat text out.

The connection icon in the header shows how this browser reaches Socio. It stays quiet while you are online and says **Reconnecting** while the server is away, for example during an update, or **Offline** when your device has no network. Hover over it or tap it for details: the round trip to the server in milliseconds, the last few measurements, when it last checked and when the connection last dropped. A slow round trip means replies and saves may lag. Socio measures it about every 30 seconds while the tab is in view, and not while it is hidden.
