---
title: 'Failure labels'
description: 'Sort the failures that Reliability’s rules leave Unclassified, and decide when the model’s labels count.'
---

## What the rules can’t sort

Operations → Reliability sorts each failed turn and tool call into a category using rules over the short codes the system records. Some codes are generic, such as a bare tool error or a failure that kept only an operator detail. The rules leave those **Unclassified**. A failure label sorts one of these. Labels only ever replace Unclassified; they never override a category the rules chose.

## Label a failure yourself

Open a row under **Recent failures** that shows Unclassified. If the failure has an error text, the panel shows it: what the model reads, with contact details and secrets removed and cut to 300 characters. Opening the panel is recorded in the access log, like opening a trace. Choose a category and select **Save label**. The dashboard counts it within a minute. You can relabel at any time, and the newest label wins. Choose Unclassified when the text doesn’t say why the failure happened.

Every admin label is also part of the **golden set**, which is the set of examples the model is checked against. Unclassified failures are labeled one at a time, so label a varied sample of them, about a hundred to start. A golden set of 20 is the minimum for an evaluation.

## Let the model suggest labels

**Operations → Settings → Failure labels** turns on suggestions from the workspace’s default shared model. Suggestions are off by default. While they are on, the model is asked once about each new Unclassified failure that has error text, a few times a minute and at most **Most calls a day** in 24 hours. A failed or invalid answer is not retried. Each suggestion appears in the failure’s panel with how sure the model was.

A suggestion counts as the failure’s category only when both of these hold:

- the model was at least as sure as the **threshold** (90% unless an admin changes it), and
- that model version has passed an evaluation.

Until both hold, suggestions stay suggestions and change no numbers. An admin’s label always wins over the model’s.

## Evaluate the model

**Evaluate** sends every golden label’s text to the model again: one call each. It reports how often the model answered and how often it was right, per label and overall. A version passes when, out of at least 10 answers given with confidence at or above the threshold, it was right at least the threshold’s share of the time. Then its earlier sure suggestions start to count. A different model, a change to the prompt or a lower threshold needs a new evaluation.

The card shows the calls, tokens and, when the model reports it, the cost of the last 24 hours. Turning suggestions off stops new calls. Labels already given stay.
