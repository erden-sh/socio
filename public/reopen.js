// Opens this address again, from this site (packages/foundation/src/web/guard.ts): a page
// opened from another site came without the session cookie. A reload keeps
// the address's #hash (old `/#/spaces/…` links), where a refresh to the same
// address with a hash would only scroll.
location.reload();
