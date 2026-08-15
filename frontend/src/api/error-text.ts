/**
 * Backend error codes → copy written for the person on the screen.
 *
 * The API's own messages are written for whoever reads the logs: "a save
 * session must be established first" and "cross-site request rejected" are
 * accurate and tell the user nothing about what to do. Worse, the most common
 * cause of both in practice is the same and is never stated - the page is on a
 * plain-http origin, where the browser drops the Secure session cookie, so
 * staging can never establish a session no matter how often it is retried.
 *
 * Deliberately a plain lookup, not an i18n framework: the UI has one language
 * (see lib/locale), and adding a framework here would mean rewriting every
 * string in the app rather than the handful that reach the user as failures.
 */

const MESSAGES: Record<string, string> = {
  SESSION_REQUIRED:
    "could not start a save session. This usually means the page is not on a secure origin: browsers drop the session cookie over plain http, so saving cannot work from a bare IP address. Open the app on localhost or over HTTPS and try again.",
  CROSS_ORIGIN_REJECTED:
    "the server rejected this request as cross-site. Open the app from the address the server itself is published on, rather than through a proxy or tunnel that rewrites the host.",
  IDEMPOTENCY_IN_PROGRESS:
    "this photo is still being saved. Wait a moment and retry - retrying is safe and will not create a second copy.",
  IDEMPOTENCY_CONFLICT:
    "this save was already completed with a different photo. Go back, regenerate the photo, and save again.",
  IDEMPOTENCY_KEY_REQUIRED: "the save request was incomplete. Retry from this page.",
  IDEMPOTENCY_UNAVAILABLE: "saving is temporarily unavailable. Wait a moment and retry.",
  PHOTO_TOO_LARGE:
    "the photo is larger than the server accepts. Go back to the editor and regenerate it at a smaller output size.",
  PHOTO_INVALID:
    "the server could not read this photo. Go back to the editor and generate the final photo again.",
  PHOTO_SIZE_MISMATCH:
    "the photo no longer matches the template's required pixel size. Go back to the editor and regenerate it.",
  KEY_EXHAUSTED:
    "no retrieval code could be allocated right now. Wait a moment and retry; if it keeps failing, staged photos need to expire first.",
  INTERNAL: "the server hit an unexpected error. Retry; if it persists, the photo was not saved.",
};

/**
 * Human-readable text for a failure. `code` is the API's error code when the
 * failure came from the API at all; `fallback` carries whatever the transport
 * or an unmapped code produced, so an unknown failure still says something
 * rather than going blank.
 */
export function errorText(code: string | undefined, fallback: string): string {
  if (code && MESSAGES[code]) return MESSAGES[code];
  return fallback || "saving failed, please retry";
}
