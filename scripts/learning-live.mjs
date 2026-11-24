#!/usr/bin/env node
// Live Learning check against a running Socio server (it starts
// nothing) and its configured model:
//
//   node scripts/learning-live.mjs --base http://127.0.0.1:4398 [--count 16]
//
// As the server's first admin (alice) and member (bob): assigns the first Dot to a fresh
// learning container with delivery on, has 15+ similar conversations, runs
// an analysis, publishes the first proposal, then starts a new conversation
// and checks that the Dot calls copilotkit_load_skill. Exits non-zero on
// failure. Uses only the mock-auth development sign-in. Starting the
// analysis by hand needs the flag learning-analyze-now on (for example
// FEATURE_FLAGS=learning-analyze-now=on); off, it answers 404 and only the
// 15-conversation threshold starts one.
import { assertFinished, mockUserId, parseArgs, signIn as signInAt, turn as startTurn } from './lib/brain-client.mjs';

const args = parseArgs(process.argv.slice(2));
const base = args.base ?? 'http://127.0.0.1:4310';
const count = Number(args.count ?? 16);
const container = args.container ?? `live-${Date.now().toString(36)}`;
const step = (text) => console.log(`[learning-live] ${text}`);
const signIn = (userId) => signInAt(base, userId);
const turn = async (user, dotId, threadId, history, text) =>
    assertFinished(await startTurn(user, dotId, threadId, history, text).done);

const topics = [
    'the website redesign',
    'the mobile app beta',
    'the billing migration',
    'the onboarding revamp',
    'the analytics dashboard',
    'the support backlog',
    'the API v2 rollout',
    'the hiring plan',
];
const asks = [
    (topic) =>
        `Draft this week's status update for ${topic}: we shipped two fixes, one risk is a vendor delay, next we test with users. Keep it short with Wins, Risks and Next steps.`,
    (topic) =>
        `Write a weekly status report for ${topic}. Progress: design approved. Blocker: waiting on legal review. Plan: start implementation. Use sections for wins, risks, next steps.`,
];

const alice = await signIn(await mockUserId(base, 'admin'));
const bob = await signIn(await mockUserId(base, 'member'));
const workspace = await alice('/workspace');
const dot = workspace.dots[0];
await alice(`/dots/${dot.id}`, 'PUT', {
    name: dot.name,
    instructions: dot.instructions,
    researchAllowed: false,
    memoryAllowed: dot.memoryAllowed,
    learningContainerId: container,
    skillDeliveryEnabled: true,
});
step(`container ${container} on Dot ${dot.name}`);

// A turn that fails (e.g. the 90 s limit on a slow model) is not evidence;
// keep going until `count` conversations have finished.
let finished = 0;
for (let i = 0; finished < count && i < count * 2; i++) {
    const user = i % 2 ? bob : alice;
    const thread = await user('/conversations', 'POST', {
        dotId: dot.id,
        title: `Status ${i + 1}`,
    });
    try {
        await turn(user, dot.id, thread.id, [], asks[i % asks.length](topics[i % topics.length]));
        finished++;
        step(`conversation ${finished}/${count} finished`);
    } catch (error) {
        step(`conversation attempt ${i + 1} failed: ${error.message}`);
    }
}
if (finished < count) {
    throw new Error('Too many failed conversations.');
}

let detail = await alice(`/learning/containers/${container}`);
step(`new evidence: ${detail.newEvidence}; running: ${detail.running}`);
// The threshold may already have started a run; otherwise start one.
if (!detail.running && !detail.proposals.length) {
    await alice(`/learning/containers/${container}/analyze`, 'POST', {});
}
const deadline = Date.now() + 10 * 60_000;
do {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    detail = await alice(`/learning/containers/${container}`);
} while (detail.running && Date.now() < deadline);
const run = detail.runs[0];
step(`analysis ${run?.status} (${run?.trigger}): ${run?.proposals} proposal(s), ${run?.dropped} dropped`);
const pending = detail.proposals.filter((p) => p.status === 'pending');
if (!pending.length) {
    throw new Error('The analysis proposed no skills.');
}
const chosen = pending[0];
const review = await alice(`/learning/proposals/${chosen.id}`);
step(`reviewing "${chosen.name}": ${chosen.description} (${review.evidence.length} evidence)`);
console.log('---- SKILL.md ----\n' + chosen.skillMd + '\n------------------');
await alice(`/learning/proposals/${chosen.id}/publish`, 'POST', {});
step(`published ${chosen.name}`);

const fresh = await bob('/conversations', 'POST', {
    dotId: dot.id,
    title: 'With the skill',
});
const events = await turn(bob, dot.id, fresh.id, [], asks[0]('the partner program'));
const loads = events.filter(
    (event) => event.type === 'TOOL_CALL_START' && event.toolCallName === 'copilotkit_load_skill',
);
if (!loads.length) {
    throw new Error('The new conversation did not load the published skill.');
}
step(`new conversation called copilotkit_load_skill (${loads.length}x)`);
step('result: PASS');
