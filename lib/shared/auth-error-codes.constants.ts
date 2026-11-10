/**
 * The stable code of everything that can go wrong and that a screen has to tell apart.
 * A code never changes its meaning; a new failure gets a new code.
 */
const AUTH_ERROR_CODES = [
  /** The browser never came back within the time limit. */
  "SIGN_IN_TIMED_OUT",
  /** The user cancelled in the program (or signed out, or the program is closing). */
  "SIGN_IN_CANCELLED",
  /** The loopback address was called too many times without the right `state`. */
  "STATE_MISMATCH",
  /** The backend refused the one-time code (`DESKTOP_CODE_INVALID`): expired, used, or not ours. */
  "CODE_REFUSED",
  /** Too many attempts from this address (`429`); `retryAfterSeconds` says how long to wait. */
  "RATE_LIMITED",
  /** The backend could not be reached. */
  "OFFLINE",
  /** The backend refused the stored session: signed out elsewhere, revoked or expired. */
  "SESSION_ENDED",
  /** The account that signed in is not a customer account. */
  "NOT_A_CUSTOMER",
  /** The system browser could not be opened. */
  "BROWSER_NOT_OPENED",
  /** The loopback listener could not be started on this machine. */
  "LISTENER_FAILED",
  /** Anything else: an answer the program does not understand. */
  "UNEXPECTED",
] as const;

export default AUTH_ERROR_CODES;
