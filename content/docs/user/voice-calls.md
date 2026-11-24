---
title: 'Voice calls'
description: 'Talk with a socio out loud, in the same conversation as your typed messages.'
---

A voice call is a spoken back-and-forth with a socio inside a chat. Start one with the phone button in the chat's header. The call view shows what you said and the socio's answer as captions, and your typed messages and the call stay in one conversation. The button is off until your team has set calls up; its tooltip says what is missing.

## Two kinds of call

Your admin chooses how calls run, in **Settings → General → Calls**. The call view says **on your team's voice server** for a self-hosted call.

- **Self-hosted.** Your speech becomes text on your team's own voice server. Each thing you say is a normal turn of the socio, as if you had typed it: the same model, tools, permissions, approvals and limits, and it appears in the chat under your name. The answer is read aloud by the voice server, or by your device's own voice when the team has no speech server. The audio stays on your team's servers and is not stored; what was said is kept as the chat's messages, as typed messages are.
- **Cloud.** The call's audio goes to OpenAI's realtime voice service. Its voice model speaks for the socio and asks the socio itself for research or anything that needs evidence. After the call, a short receipt of it is added to the chat.

## During a call

Speak naturally and pause when you are done; the socio answers after a short silence. To cut an answer short, start talking or press **Interrupt** (self-hosted calls). **Mute** stops your microphone, **Speaker** silences the socio, and **End** hangs up. A call ends by itself after 15 minutes.

Use headphones if you can. On speakers, some devices let the socio hear its own voice, which can make it stop or answer itself. When your device speaks the replies, your microphone pauses while it talks for the same reason.

Speech recognition can mishear names and numbers. Check anything important in the chat afterwards, where every turn of a self-hosted call is written out. Long answers are shortened when spoken; the full text is in the chat.

## Approvals and limits

A self-hosted call follows the same rules as typing. When the socio needs your approval, the call says **Approval needed** and the request waits in the chat; the socio carries on there once you decide. The workspace's limits on how much work a turn or a conversation may do apply to spoken turns too, and a paused workspace takes no calls. See [Approvals](/docs/approvals).

## When a call can't start

If your team's voice server is down, the call stops before it starts and the chat says why, for example "The self-hosted voice server isn't answering". Try again in a few minutes, or type instead. Where your team has also set up cloud calls, **Use cloud voice** makes that one call over the cloud instead; the call's audio then goes to OpenAI.

If the speech server stops answering during a call, your device reads the rest of the replies aloud. A call that drops can be started again; turns that finished are already in the chat. For anything else, see [Chats](/docs/chats) and [Privacy](/docs/privacy).
