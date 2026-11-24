---
title: 'Schedules and jobs'
description: 'Review recurring prompts, code jobs and work that runs until done.'
---

**Schedules & jobs** brings your recurring work together. You see your own schedules, goals and jobs; another person's private work is not added because you use the same socio.

## Choose the kind of work

A schedule runs a socio with a fixed prompt at a cadence, in its own conversation and on your inference connection. A goal asks the socio to work toward an outcome and record progress. A job runs saved code in the socio's computer without asking the model to generate each step.

Describe the task, cadence and time zone in a conversation. Examples include “every day at 09:00” or “every Monday at 08:30”; five-field cron is also supported. Specify your time zone to avoid surprises: a missing zone defaults to UTC. A new schedule, goal or saved job version can require your approval.

## Review and control

Open the schedule to inspect its prompt, socio, next run and latest outcome. Pause it when work should wait, resume it when ready, or cancel it when no longer needed. **Run now** starts a run; it does not merely preview one. Check [approvals](/docs/approvals) before expecting an unapproved proposal to run.

Jobs need configured computers and appropriate shell permissions. The app limits timeouts, concurrent runs and resource use. A successful exit code reports the code's outcome, not the truth of data it collected. Inspect output and results before relying on them.

## Jobs that run until done

Some jobs keep a durable list of items and checkpoints across batches. Their progress view shows done, remaining and failed items, the checkpoint, retries and whether the job is waiting after a refusal. A batch finishing successfully does not mean the whole job is finished. A long run can resume after a restart or computer interruption; failed items can be set aside after retries. Use **Stop** when you want it to end.

## When nothing runs

Check whether the schedule is paused, whether Socio is paused globally, whether the shared or personal model is available and whether an approval is waiting. The scheduler depends on research being allowed in workspace settings. A computer job also needs its computer service. Ask an admin about limits rather than creating duplicate schedules to work around them.

For outcome-driven work, read [Goals](/docs/goals).
