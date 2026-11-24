import { NotFound } from './NotFound';

/**
 * `/reset-password` and `/sign-in-link`. With a `?token`, the shell shows
 * the sign-in screen instead of its pages; without one, nothing is here.
 */
export default function OneTimeLink() {
    return <NotFound />;
}
