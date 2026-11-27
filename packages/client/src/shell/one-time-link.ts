/**
 * A password link (invite or reset) or a sign-in link: the sign-in screen
 * shows for it signed in or out.
 */
export const oneTimeLink = (location: { pathname: string; search: string }) =>
    ['/reset-password', '/sign-in-link'].includes(location.pathname) &&
    new URLSearchParams(location.search).has('token');
