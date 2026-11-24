import { consentCheck, formOpen, turnstileSlot } from '../forms.ts';
import { icon } from '../icons.ts';
import type { Assets } from '../layout.ts';
import { m, page, sq } from '../layout.ts';

// ---------------------------------------------------------------- hosted

export const hosted = (assets: Assets) =>
    page({
        key: 'hosted',
        active: 'hosted',
        assets,
        body: `<section class="page-hero t-mint tw:[--tone2:var(--amber-500)]"><div class="container with-art">
  <div><span class="pill t-amber"><span class="dot">${icon('sparkles')}</span>Early access</span>
  <h1>We run Socio for you.</h1>
  <p class="lede">A private Socio workspace for your small business, set up and looked after by us. No servers to run, no updates to install. Join the waitlist and we’ll reach out as places open.</p></div>
  <div class="art">${m('manny')}${m('sebas')}${m('mingo')}</div>
</div></section>

<section class="tw:pt-6"><div class="container">
  <div class="tiles">
    <div class="tile t-mint">${sq('mint', 'building-2')}<h3>A workspace that’s yours</h3><p>Your own private workspace, your own data key. Not shared with other customers.</p></div>
    <div class="tile t-sky">${sq('sky', 'refresh-cw')}<h3>Updates, done for you</h3><p>New features arrive on their own, tested first. You never touch a server.</p></div>
    <div class="tile t-emerald">${sq('emerald', 'database-backup')}<h3>Daily backups</h3><p>Backed up every day, encrypted, and kept in a second location.</p></div>
    <div class="tile t-indigo">${sq('indigo', 'bot')}<h3>Socios, ready to work</h3><p>Pick your characters and we connect a capable AI model for you.</p></div>
    <div class="tile t-amber">${sq('amber', 'smartphone')}<h3>Web and phone</h3><p>The web app plus the iPhone and Android app, with push approvals.</p></div>
    <div class="tile t-orange">${sq('orange', 'life-buoy')}<h3>A person to talk to</h3><p>Real help from the team that builds Socio, by email.</p></div>
  </div>
</div></section>

<section class="tw:pt-0" id="waitlist"><div class="container tw:grid tw:grid-cols-[minmax(0,1fr)_minmax(0,1.35fr)] tw:gap-10 tw:items-start" data-stack>
  <div>
    <div class="section-head t-amber tw:text-left tw:mx-0 tw:mt-0 tw:mb-6"><div class="kicker">How early access works</div><h2>Small groups, in order</h2><p>We open hosted workspaces a few teams at a time, so each one gets a good start.</p></div>
    <div class="tw:grid tw:gap-[.8rem]">
      <div class="step t-amber tw:flex tw:gap-4"><span class="n">1</span><div><h4 class="tw:m-0">Join the waitlist</h4><p>Tell us a little about your team. Two minutes.</p></div></div>
      <div class="step t-amber tw:flex tw:gap-4"><span class="n">2</span><div><h4 class="tw:m-0">A short call</h4><p>We learn how you work and what your socios should do.</p></div></div>
      <div class="step t-amber tw:flex tw:gap-4"><span class="n">3</span><div><h4 class="tw:m-0">Your workspace opens</h4><p>We set it up, invite your team and stay close for the first weeks.</p></div></div>
    </div>
    <p class="muted tw:mt-[1.2rem] tw:text-[.92rem]">Pricing comes later. Early-access teams pay nothing until we agree a price together, with 30 days’ notice.</p>
  </div>
  ${formOpen('waitlist', 'form-card')}<h3>Join the hosted waitlist</h3><p class="sub">We reply to every team. Fields marked optional can stay empty.</p>
    <div class="form-grid">
      <div class="field"><label for="w-name">Your name</label><input class="input" id="w-name" name="name" autocomplete="name" placeholder="Your name" required maxlength="120"></div>
      <div class="field"><label for="w-email">Work email</label><input class="input" id="w-email" name="email" type="email" autocomplete="email" placeholder="you@company.com" required maxlength="254"></div>
      <div class="field"><label for="w-company">Company</label><input class="input" id="w-company" name="company" autocomplete="organization" placeholder="Company name" required maxlength="160"></div>
      <div class="field"><label for="w-size">Team size</label><select class="select" id="w-size" name="team_size" required><option value="1">Just me</option><option value="2-10" selected>2–10 people</option><option value="11-50">11–50 people</option><option value="51-200">51–200 people</option><option value="200+">More than 200</option></select></div>
      <fieldset class="field full"><legend class="label">I’m interested in</legend><div class="chips"><label class="chip t-mint"><input type="checkbox" name="interest" value="hosted" checked>${icon('heart-handshake')}Hosted Socio</label><label class="chip t-indigo"><input type="checkbox" name="interest" value="self-host">${icon('terminal')}Running it myself</label><label class="chip t-sky"><input type="checkbox" name="interest" value="mobile">${icon('smartphone')}The mobile app</label></div></fieldset>
      <div class="field full"><label for="w-message">What should your socios help with? <span class="opt">(optional)</span></label><textarea class="textarea" id="w-message" name="message" maxlength="2000" placeholder="Bookings, the client newsletter, keeping the handbook up to date…"></textarea></div>
      <div class="field full">${consentCheck('consent', 'I agree to the <a href="/privacy">Privacy Policy</a> and to be contacted about hosted Socio.')}</div>
    </div>
    <div class="form-foot">${turnstileSlot()}<button class="btn btn-primary btn-lg" type="submit">Join the waitlist ${icon('arrow-right')}</button></div>
  </form>
</div></section>

<section class="tw:pt-0"><div class="container tw:max-w-[820px]">
  <div class="section-head tw:mb-6"><h2 class="tw:text-[2rem]">Questions</h2></div>
  <div class="faq">
    <details open><summary>How much will it cost?${icon('plus')}</summary><p>We’ll set prices with our early-access teams. Nobody pays anything until a price is agreed, and we give 30 days’ notice before any change.</p></details>
    <details><summary>Where is my data kept?${icon('plus')}</summary><p>In a private workspace on servers we manage, encrypted at rest and backed up daily to a second location. Your workspace’s files and secrets are sealed with a key of its own.</p></details>
    <details><summary>Can I move to self-hosting later?${icon('plus')}</summary><p>Yes. Hosted and self-hosted Socio run the same software, so we can hand you an export of your workspace.</p></details>
    <details><summary>Which AI model do socios use?${icon('plus')}</summary><p>We connect a capable model for you and tell you which. Your workspace’s messages are sent to it only to produce answers.</p></details>
  </div>
</div></section>`,
    });
