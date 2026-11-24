import { consentCheck, formOpen, turnstileSlot } from '../forms.ts';
import { icon } from '../icons.ts';
import type { Assets } from '../layout.ts';
import { m, page, sq } from '../layout.ts';

// ---------------------------------------------------------------- open source

export const selfHost = (assets: Assets) =>
    page({
        key: 'self-host',
        active: 'self-host',
        assets,
        body: `<section class="page-hero t-indigo tw:[--tone2:var(--emerald-500)]"><div class="container with-art">
  <div><span class="pill t-indigo"><span class="dot">${icon('clock')}</span>Code coming soon · moving to the erden-sh org</span>
  <h1>Run Socio yourself, on your own servers.</h1>
  <p class="lede">Socio’s base is going public under the Sustainable Use License, the model n8n uses: free to run for your own team, with your own AI model. We’re tidying the repository now.</p>
  <div class="ctas tw:flex tw:gap-[.7rem] tw:mt-[1.8rem] tw:flex-wrap"><a class="btn btn-primary btn-lg" href="#notify">${icon('bell')}Tell me when it’s public</a><a class="btn btn-outline btn-lg" href="/hosted">Rather we host it?</a></div></div>
  <div class="art">${m('rulo')}${m('iggy')}${m('flake')}</div>
</div></section>

<section class="tw:pt-8"><div class="container">
  <div class="section-head t-emerald"><div class="kicker">The license, in plain words</div><h2>Free for your team. Not for resale.</h2><p>The Sustainable Use License lets you run, change and share Socio for your own business. It doesn’t let you sell Socio to others as a competing service.</p></div>
  <div class="license-grid">
    <div class="license-col yes"><h3>${sq('emerald', 'circle-check', 'sm')}You can</h3><ul>
      <li>${icon('check')}<span>Run Socio for your company or team, on your own servers, at no cost</span></li>
      <li>${icon('check')}<span>Change the code to fit how you work</span></li>
      <li>${icon('check')}<span>Use it for personal and non-commercial projects</span></li>
      <li>${icon('check')}<span>Share it, free of charge, for non-commercial purposes, with the license attached</span></li>
    </ul></div>
    <div class="license-col no"><h3>${sq('rose', 'circle-x', 'sm')}You can’t</h3><ul>
      <li>${icon('x')}<span>Sell Socio, or a modified copy, as a hosted service or product that competes with ours</span></li>
      <li>${icon('x')}<span>Charge others for access to Socio you run for them</span></li>
      <li>${icon('x')}<span>Remove the license, copyright or other notices</span></li>
      <li>${icon('x')}<span>Use the Socio name, logo or characters as your own brand</span></li>
    </ul></div>
  </div>
  <p class="muted tw:text-center tw:mt-[1.2rem] tw:text-[.9rem]">This summary isn’t the license. The full text ships in the repository’s LICENSE file. Want to offer Socio commercially? <a class="inline-link" href="/support#contact">Talk to us</a>.</p>
</div></section>

<section class="tw:pt-0"><div class="container">
  <div class="section-head t-sky"><div class="kicker">What’s in the box</div><h2>The base is open. Special features are plugins.</h2></div>
  <div class="tiles">
    <div class="tile t-mint">${sq('mint', 'message-circle')}<h3>Chats, rooms and socios</h3><p>The full workspace: chats, rooms, handoffs, memories and schedules.</p></div>
    <div class="tile t-sky">${sq('sky', 'folder')}<h3>Spaces, pages and the board</h3><p>Docs your socios read, and a board for bugs and requests.</p></div>
    <div class="tile t-amber">${sq('amber', 'shield-check')}<h3>Approvals and roles</h3><p>Socios ask before acting. Admins, members and invites built in.</p></div>
    <div class="tile t-indigo">${sq('indigo', 'smartphone')}<h3>The mobile app</h3><p>The iPhone and Android app connects to your own workspace.</p></div>
    <div class="tile t-emerald">${sq('emerald', 'database-backup')}<h3>Backups and encryption</h3><p>Scheduled backups, with files and secrets sealed by your own key.</p></div>
    <div class="tile t-violet">${sq('violet', 'puzzle')}<h3>Plugins</h3><p>Add-ons for specific industries or customers, installed when you need them.</p></div>
  </div>
</div></section>

<section class="tw:pt-0"><div class="container">
  <div class="section-head t-orange"><div class="kicker">Self-hosting</div><h2>Up and running in three steps</h2></div>
  <div class="steps">
    <div class="step t-orange"><span class="n">1</span><h4>Get a server</h4><p>Any Linux machine with Docker. One small server runs a whole team.</p></div>
    <div class="step t-orange"><span class="n">2</span><h4>Deploy the stack</h4><p>One Docker Swarm stack: the workspace, its database and backups, with your domain and certificates.</p></div>
    <div class="step t-orange"><span class="n">3</span><h4>Plug in a model</h4><p>Point Socio at any OpenAI-compatible endpoint, hosted or on your own hardware. Invite your team.</p></div>
  </div>
  <div class="codebox locked tw:mt-4"><span class="c"># Quick start: published with the code</span><br><span class="p">$</span> git clone https://github.com/████/socio<br><span class="p">$</span> cp deployment/.env.example deployment/.env<br><span class="p">$</span> docker stack deploy -c deployment/stack.yml socio<span class="lock"><span>${icon('lock')}Available when the code is public</span></span></div>
</div></section>

<section class="tw:pt-0" id="notify"><div class="container tw:max-w-[760px]">
  ${formOpen('notify', 'form-card')}<div class="tw:flex tw:gap-4 tw:items-center">${sq('indigo', 'bell')}<div><h3>Get a note when the code is public</h3><p class="sub">One email when the repository opens. Nothing else.</p></div></div>
    <div class="form-grid"><div class="field"><label for="n-name">Name</label><input class="input" id="n-name" name="name" autocomplete="name" placeholder="Your name" required maxlength="120"></div><div class="field"><label for="n-email">Email</label><input class="input" id="n-email" name="email" type="email" autocomplete="email" placeholder="you@company.com" required maxlength="254"></div>
    <div class="field full">${consentCheck('consent', 'I agree to the <a href="/privacy">Privacy Policy</a>. We’ll only email you about Socio’s code.')}</div></div>
    <div class="form-foot">${turnstileSlot()}<button class="btn btn-primary btn-lg" type="submit">Notify me</button></div>
  </form>
</div></section>`,
    });
