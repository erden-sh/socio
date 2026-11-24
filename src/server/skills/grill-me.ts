/**
 * `/grill-me` (CB-143), adapted from Matt Pocock's `grill-me` skill, which
 * runs his `grilling` skill: https://github.com/mattpocock/skills,
 * `skills/productivity/grill-me/SKILL.md` and
 * `skills/productivity/grilling/SKILL.md` at commit
 * 5beb35b040e3de97e54fa9e386d7e42d15c295c2.
 *
 * MIT License. Copyright (c) 2026 Matt Pocock. Permission is hereby
 * granted, free of charge, to any person obtaining a copy of this software
 * and associated documentation files (the "Software"), to deal in the
 * Software without restriction, including without limitation the rights to
 * use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions: The above
 * copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software. THE SOFTWARE IS PROVIDED
 * "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
 * NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A
 * PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
 * COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
 * WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF
 * OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 *
 * What changed: the person is "the person", not "the user"; facts are
 * found with the Dot's own tools rather than a sub-agent; and the session
 * ends with `end_skill` (this app's way to end a skill that stays on)
 * once the person confirms the shared understanding or says they are done.
 * The rounds, the design tree, the frontier, the recommended answers and
 * the "yes accepts" wording are the original's.
 */
import type { ChatSkillLock } from '@socio/shared/chat/chat-skills';

export const GRILL_ME_SOURCE: Omit<ChatSkillLock, 'sha256'> = {
    source: 'builtin',
    url: 'https://github.com/mattpocock/skills',
    path: 'skills/productivity/grilling/SKILL.md',
    ref: 'main',
    commit: '5beb35b040e3de97e54fa9e386d7e42d15c295c2',
    license: 'MIT, Copyright (c) 2026 Matt Pocock',
};

export const GRILL_ME_INSTRUCTIONS = `Interview the person relentlessly about their plan, decision or idea until you reach a shared understanding. Map it as a design tree: every decision branches into the decisions that hang off it.

Work the tree in rounds. The frontier is every decision whose prerequisites are already settled: the questions you can ask now without guessing at answers you haven't heard yet. Ask the whole frontier in one round: number each question and give your recommended answer. Then wait for the person's answers before the next round.

Format a round like so:

❓ **Q1** - **<question title>**: <question body, might be multiple paragraphs, including multiple choices>

➡️ <your recommended answer>

---

❓ **Q2** - **<question title>**: <question body, might be multiple paragraphs, including multiple choices>

➡️ <your recommended answer>

Word each question so "yes" accepts your recommended answer.

Each round the person answers reshapes the tree: settled decisions push the frontier outward and unblock questions that depended on them. Recompute the frontier and ask the next round. A question whose answer depends on another question still open in this round belongs to a later round, not this one.

Finding facts is your job, never the person's. When a frontier question needs a fact you can look up with your tools (pages, data, the web), look it up; don't ask the person for anything you could find yourself. Don't block on it: only the questions downstream of a fact you are still finding wait for it; ask the rest of the frontier now. The decisions are the person's: put each to them and wait.

The session is done when the frontier is empty: every branch of the design tree visited, nothing left silently assumed. Do not act on it until the person confirms you have reached a shared understanding; then sum up the decisions and end the skill.`;
