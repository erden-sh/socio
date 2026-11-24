import { MENU_PATHS, SECURITY_EMAIL, SUPPORT_EMAIL } from '../facts.ts';
import { formOpen, turnstileSlot } from '../forms.ts';
import { icon } from '../icons.ts';
import type { Assets } from '../layout.ts';
import { m, menuPath, page, sq } from '../layout.ts';

// ---------------------------------------------------------------- support

export const support = (assets: Assets) =>
    page({
        key: 'support',
        active: 'support',
        assets,
        body: `<section class="page-hero t-sky tw:[--tone2:var(--brand)]"><div class="container with-art">
  <div><span class="pill t-sky"><span class="dot">${icon('life-buoy')}</span>Support</span><h1>How can we help?</h1><p class="lede">Quick answers first. If you’re still stuck, write to us and a person will reply, usually within one business day.</p></div>
  <div class="art">${m('manny')}${m('lino')}</div>
</div></section>
<section class="tw:pt-2"><div class="container">
  <div class="topic-grid">
    <a class="topic" href="#signin">${sq('mint', 'key-round', 'sm')}<h4>Signing in</h4><p>Codes, invites, new phones</p></a>
    <a class="topic" href="#admin">${sq('indigo', 'building-2', 'sm')}<h4>Your workspace</h4><p>Admins and members</p></a>
    <a class="topic" href="#notifications">${sq('amber', 'bell', 'sm')}<h4>Notifications</h4><p>Push and approvals</p></a>
    <a class="topic" href="#phone">${sq('sky', 'smartphone', 'sm')}<h4>The app</h4><p>Offline, storage, updates</p></a>
    <a class="topic" href="#account">${sq('rose', 'user-round-x', 'sm')}<h4>Account and data</h4><p>Leave, delete, export</p></a>
  </div>
  <div class="support-layout tw:mt-10">
    <div class="faq">
      <h3 class="group-title" id="signin">${sq('mint', 'key-round', 'sm')}Signing in</h3>
      <details open><summary>I didn’t get my sign-in code${icon('plus')}</summary><p>Codes arrive within a minute. Check spam, and make sure you’re using the email your invite went to. Codes expire after 10 minutes, so ask for a new one if it’s been a while.</p></details>
      <details><summary>How do I join my team’s workspace?${icon('plus')}</summary><p>Workspaces are invite-only. Ask your workspace admin to invite your email, then open the link in the invite on your phone or computer.</p></details>
      <details><summary>I got a new phone${icon('plus')}</summary><p>Install Socio, then on the web open the menu under your name and choose ${menuPath(MENU_PATHS.webAddDevice)}. Scan the code with your new phone, and sign out of the old one if you still have it.</p></details>
      <h3 class="group-title" id="admin">${sq('indigo', 'building-2', 'sm')}Your workspace</h3>
      <details><summary>My company runs our workspace. Who do I ask?${icon('plus')}</summary><p>Your workspace admin manages accounts, invites and data for your team. We can help admins of workspaces we host; for a self-hosted workspace, your admin is the right person.</p></details>
      <details><summary>Can I choose which socios I talk to?${icon('plus')}</summary><p>Yes. Start a chat with any socio your workspace has, or @mention one in a room to bring it in.</p></details>
      <h3 class="group-title" id="notifications">${sq('amber', 'bell', 'sm')}Notifications</h3>
      <details><summary>I’m not getting notifications${icon('plus')}</summary><p>Check that notifications are on for Socio in your phone’s settings, then in the app under ${menuPath(MENU_PATHS.appNotifications)}. Notifications are sealed for your phone, so they show up only once the app has been opened since install.</p></details>
      <h3 class="group-title" id="phone">${sq('sky', 'smartphone', 'sm')}The app</h3>
      <details><summary>Does the app work offline?${icon('plus')}</summary><p>You can read what’s already on your phone and write messages that send when you’re back online. The copy on your phone is encrypted.</p></details>
      <h3 class="group-title" id="account">${sq('rose', 'user-round-x', 'sm')}Account and data</h3>
      <details><summary>How do I leave a workspace?${icon('plus')}</summary><p>On the web, open ${menuPath(MENU_PATHS.webLeave)}. In the Socio app (latest version), open ${menuPath(MENU_PATHS.appLeave)}; if your app doesn’t show it yet, use the web. Leaving deactivates your account in that workspace: you’re signed out on every device, your content stays with the workspace, and an admin can let you back in. If you’re its only admin, make someone else an admin first; if you own it, make another admin its owner first. See <a class="inline-link" href="/delete-account#leave">Leave a workspace</a> for what it does.</p></details>
      <details><summary>How do I delete my account?${icon('plus')}</summary><p>Ask your workspace admin: your company owns its accounts, and the admin closes them. Leaving a workspace deactivates your account but doesn’t remove it for good, and signing out of the app only takes the workspace off that device. See <a class="inline-link" href="/delete-account">Delete your account</a> for the steps and what happens to your data.</p></details>
    </div>
    <div class="aside-stack" id="contact">
      ${formOpen('support', 'form-card')}<h3>Still stuck?</h3><p class="sub">Send us a note. Include your workspace’s address if you have one.</p>
        <div class="tw:grid tw:gap-[.9rem] tw:mt-[1.2rem]">
          <div class="field"><label for="s-email">Email</label><input class="input" id="s-email" name="email" type="email" autocomplete="email" placeholder="you@company.com" required maxlength="254"></div>
          <div class="field"><label for="s-topic">Topic</label><select class="select" id="s-topic" name="topic" required><option value="signin">Signing in</option><option value="workspace">Your workspace</option><option value="notifications">Notifications</option><option value="app">The app</option><option value="account">Account and data</option><option value="other">Something else</option></select></div>
          <div class="field"><label for="s-message">What’s happening?</label><textarea class="textarea" id="s-message" name="message" required maxlength="4000" placeholder="Tell us what you tried and what you saw"></textarea></div>
          ${turnstileSlot()}
          <button class="btn btn-primary btn-block" type="submit">Send message</button>
        </div></form>
      <div class="contact-line">${sq('mint', 'mail', 'sm')}<div><b>Email us</b><a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a></div></div>
      <div class="contact-line">${sq('slate', 'shield-alert', 'sm')}<div><b>Report a security issue</b><a href="mailto:${SECURITY_EMAIL}">${SECURITY_EMAIL}</a></div></div>
    </div>
  </div>
</div></section>`,
    });
