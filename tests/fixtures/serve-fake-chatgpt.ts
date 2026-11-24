// Testing only: the fake ChatGPT (auth server and Codex backend) as a local
// server for smoke runs (`ui-smoke.mjs --scenario byo`). Loopback only.
// Sign-ins are approved as soon as they are polled, and every turn gets the
// same short answer, after a short reasoning summary.
//
//   node --import tsx tests/fixtures/serve-fake-chatgpt.ts [port]
//
// Then start the app with CHATGPT_AUTH_ISSUER and CHATGPT_BASE_URL as printed.
import { startFakeChatGpt, textReply } from './fake-chatgpt.js';

const fake = await startFakeChatGpt({ port: Number(process.argv[2] ?? 4512) });
fake.state.device = 'approved';
fake.state.autoReply = () =>
    textReply('Hello from your ChatGPT plan (fake ChatGPT).', 'resp_1', {
        summary: 'Greeting the user from their plan.',
    });
console.log(
    `fake ChatGPT: CHATGPT_AUTH_ISSUER=${fake.endpoints.issuer} CHATGPT_BASE_URL=${fake.endpoints.codexBaseUrl}`,
);
