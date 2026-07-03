/** The desk session cookie: httpOnly, holds the subscriber's portal token. */
export const DESK_COOKIE = "mp_desk";

/**
 * 400 days — Chrome's hard cap on cookie lifetime. Refreshed on every desk
 * visit, so anyone who opens the site even once a year stays signed in
 * until they deliberately sign out.
 */
export const DESK_COOKIE_MAX_AGE = 400 * 24 * 60 * 60;
