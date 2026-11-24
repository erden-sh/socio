import { ERASURE_DAYS, MENU_PATHS, PRIVACY_EMAIL } from '../facts.ts';
import { icon } from '../icons.ts';
import type { Assets } from '../layout.ts';
import { m, menuPath, page, sq } from '../layout.ts';

// Play's Delete account URL. Only real steps (the owner's decisions of 2026-11-16): the company
// owns its accounts, an admin closes them, a phone's sign-out erases only that phone's copy.
// Leaving a workspace yourself (CB-383, server v0.42.0) is a deactivation the person asks for
// (@socio/shared/leave-workspace); the app's row isn't in a released build yet, so its step says
// "latest version" and points to the web. The admin portal (CB-386) isn't built: it gets a
// "coming soon" line and no steps. Every menu path comes from MENU_PATHS, which
// tests/facts.test.ts holds to the clients' labels.

export const deleteAccount = (assets: Assets) =>
    page({
        key: 'delete-account',
        active: 'legal',
        assets,
        body: `<section class="page-hero t-rose tw:[--tone2:var(--indigo-500)]"><div class="container with-art">
  <div><span class="pill t-rose"><span class="dot">${icon('user-round-x')}</span>Account and data</span><h1>Delete your Socio account</h1><p class="lede">Your Socio account belongs to your company’s workspace, and the workspace’s admin manages it. Here is how to sign out of a device, how to leave a workspace, how your account is closed, and what happens to your data.</p></div>
  <div class="art">${m('rosy')}${m('manny')}</div>
</div></section>
<section class="tw:pt-4"><div class="container">
  <div class="path-grid">
    <div class="path t-mint" id="sign-out">${sq('mint', 'log-out')}<h3>Sign out of a device</h3><p>This takes the workspace off one device. Your account stays open.</p>
      <ol><li><span>In the Socio app, open ${menuPath(MENU_PATHS.appSignOut)}.</span></li><li><span>On the web, open the menu under your name and choose ${menuPath(MENU_PATHS.webSignOut)}.</span></li><li><span>On a phone, signing out erases the workspace’s copy from it, including anything you hadn’t sent yet.</span></li></ol>
      <p class="muted tw:mt-4 tw:text-[.92rem]">Signing out doesn’t close your account. To stop being a member, <a class="inline-link" href="#leave">leave the workspace</a>. To close your account, ask your workspace admin.</p></div>
    <div class="path t-rose" id="leave">${sq('rose', 'door-open')}<h3>Leave a workspace</h3><p>You can leave a workspace yourself. Leaving deactivates your account in that workspace.</p>
      <ol><li><span>On the web, open ${menuPath(MENU_PATHS.webLeave)} and confirm.</span></li><li><span>In the Socio app (latest version), open ${menuPath(MENU_PATHS.appLeave)} and confirm. If your app doesn’t show it yet, use the web.</span></li><li><span>You can’t sign in again, your sessions end on every device, each phone erases the workspace’s copy, and your devices stop getting its notifications.</span></li></ol>
      <p class="muted tw:mt-4 tw:text-[.92rem]">Your content stays with the workspace. An admin can let you back in. If you’re the workspace’s only admin, make someone else an admin before you leave; if you own the workspace, make another admin its owner first. Leaving doesn’t remove your account for good: for that, ask your admin or the workspace’s owner, as in <a class="inline-link" href="#close">Close your account</a>.</p></div>
    <div class="path t-indigo tw:[grid-column:1/-1]" id="close">${sq('indigo', 'shield-user')}<h3>Close your account</h3><p>Your company owns its workspace’s accounts, so its admin closes them.</p>
      <ol><li><span>Ask your workspace admin to close your account. In most companies that’s whoever invited you.</span></li><li><span>The admin opens ${menuPath(MENU_PATHS.webPeople)} on the web, picks you, and chooses ${menuPath(MENU_PATHS.webDeactivate)}. You can’t sign in again, your sessions end on every device, and each phone erases the workspace’s copy.</span></li><li><span>To have your account removed for good, ask for it. Once an admin has handed what you own to someone else, the workspace’s owner can remove your account permanently.</span></li></ol>
      <div class="soon">${sq('indigo', 'sparkles', 'sm')}<span><b>Coming soon:</b> an admin portal for managing members and data requests.</span></div></div>
  </div>
  <div class="card tw:mt-5 tw:flex tw:gap-5 tw:items-center tw:flex-wrap">${sq('amber', 'building-2')}<div class="tw:flex-1 tw:min-w-64"><h3 class="tw:m-0 tw:text-[1.15rem]">Is your workspace hosted by us?</h3><p class="muted tw:mt-[.3rem]">If your admin can’t be reached, or you are the admin, write to us from the email on the account. We work with your workspace’s owner to close it, and reply within 30 days.</p></div><a class="btn btn-outline" href="mailto:${PRIVACY_EMAIL}">${icon('mail')}${PRIVACY_EMAIL}</a></div>
</div></section>
<section class="tw:pt-0"><div class="container">
  <div class="section-head t-rose tw:mb-8"><div class="kicker">What happens to your data</div><h2>Removed, kept, and why</h2></div>
  <div class="kept">
    <div class="item t-rose">${sq('rose', 'trash-2', 'sm')}<h4>Deleted</h4><p>On permanent removal: your account and its sign-in data, devices, sessions and notification registrations. The app’s copy on a phone is erased when you sign out, leave the workspace, or your account is deactivated.</p></div>
    <div class="item t-sky">${sq('sky', 'users', 'sm')}<h4>Kept by your workspace</h4><p>Your content stays: chats, memories, pages and board items. The workspace belongs to your company, so an admin hands what you owned to someone else before your account can be removed.</p></div>
    <div class="item t-amber">${sq('amber', 'clock', 'sm')}<h4>How long it takes</h4><p>Access ends right away. Permanent removal completes within ${ERASURE_DAYS} days of the request, and in backups once they roll off. Records the law requires are kept only as long as it requires.</p></div>
  </div>
  <p class="muted tw:text-center tw:mt-6">For a workspace we host, your company decides what happens to its content. For data Ingenio holds itself, write to <a class="inline-link" href="mailto:${PRIVACY_EMAIL}">${PRIVACY_EMAIL}</a>.</p>
  <p class="muted tw:text-center tw:mt-6">More detail in our <a class="inline-link" href="/privacy#retention">Privacy Policy</a>.</p>
</div></section>`,
    });
