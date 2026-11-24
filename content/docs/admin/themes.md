---
title: 'Intent and themes'
description: 'See what people come to socios for, which kinds of work get left unfinished, and how to check the model before its labels count.'
---

## What Themes shows

**Operations → Themes** sorts people's sessions two ways. **Intent** is what a person came for, one label from a short list: ask, write, analyze, automate, research, admin or other, or a list your admins edit. **Themes** are the topics sessions are about, in a few words each, grouped when they use the same words ("March invoices" and "invoice for March" are one theme) and counted per week.

Each row shows how many sessions there were, how many different people had them, and how the sessions ended: completed, answered or abandoned, as **Value** counts them. Value also has a **Completion by intent** card. The hint next to a theme is the model's read of the first messages, which can differ from what happened.

## Privacy

Themes shows counts, never transcripts. A theme is named only when **at least three different people** had sessions on it in the range and filters you picked; smaller themes are counted together and never named. Narrowing Operations to one person therefore names no theme, and that view is written to the access log.

The model reads a chat's title and the first three messages a person wrote in a session. Contact details and secret-like strings are removed and each text is cut to 300 characters before the model sees it. It is asked never to put names or identifying details in a topic.

## Turn it on

Both are off by default. **Operations → Settings → Session intent** and **Session themes** each have a switch, a threshold and a daily cap of model calls. They use the workspace's default shared model. While a switch is on, each new session is asked about once, after its first three messages or when it ends.

The intent card also holds the list of intents, with a sentence each that tells the model what it means. Changing the list starts a new golden set: the model must pass an evaluation on the new list before its intents count. Sessions already labeled keep their intent.

## Review sessions and evaluate

Until the model passes an evaluation, its answers are suggestions and change no numbers. The **Review** card on Themes lists sessions the model labeled. Opening one shows the scrubbed text it read and its answers, and is written to the access log. Set the right intent, or up to three topics and whether it seems resolved, and save: your label counts within a minute and joins that use's **golden set**.

With 20 or more of your labels, **Evaluate** in Settings asks the model about each again. An intent is right when it matches yours. Topics are right when the outcome hint matches and at least one topic shares half its words with one of yours. The model passes when, out of at least 10 answers it was sure of, it was right at least the threshold's share of the time (80% for intent and 70% for themes, unless you change them). Then its earlier sure answers start to count as well.
