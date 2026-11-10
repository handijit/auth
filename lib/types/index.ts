import type AUTH_ERROR_CODES from "../shared/auth-error-codes.constants";
import type AUTH_STATUSES from "../shared/auth-statuses.constants";

/** Where the session stands: `loading` until the stored session has been read. */
type AuthStatus = (typeof AUTH_STATUSES)[number];

/** The stable code of a failure (see `AUTH_ERROR_CODES`). */
type AuthErrorCode = (typeof AUTH_ERROR_CODES)[number];

/** Who is signed in. */
type AuthUser = {
  /** The account's id at the backend. */
  readonly id: number;
  /** The account's e-mail address. */
  readonly email: string;
  /** The name to greet the customer with. */
  readonly name: string;
};

/** A failure a screen can show as it is. */
type AuthError = {
  /** What happened; stable, safe to branch on. */
  readonly code: AuthErrorCode;
  /** The Turkish sentence for the customer. */
  readonly message: string;
  /** With `RATE_LIMITED`: how many seconds the backend asked to wait. */
  readonly retryAfterSeconds?: number;
};

/** The session as every process sees it. It never holds a token. */
type AuthState = {
  /** `loading`, `signed-out`, `signing-in` (the browser is open) or `signed-in`. */
  readonly status: AuthStatus;
  /** The signed-in customer; `null` unless `status` is `signed-in`. */
  readonly user: AuthUser | null;
  /** Why the last sign-in failed or the session ended; `null` after a success or a cancel. */
  readonly error: AuthError | null;
  /**
   * Whether the session will survive a restart. `false` while signed in means the operating
   * system offers no encryption, so the session lives in memory for this run only.
   */
  readonly isRemembered: boolean;
};

/** What a sign-in resolves with. A failure is an answer, not a rejection. */
type SignInResult =
  | {
      /** The customer is signed in. */
      readonly ok: true;
      /** Who signed in. */
      readonly user: AuthUser;
    }
  | {
      /** Nobody is signed in. */
      readonly ok: false;
      /** Why not. A cancel is `SIGN_IN_CANCELLED`. */
      readonly error: AuthError;
    };

/** Removes the listener it was returned for. Safe to call more than once. */
type Unsubscribe = () => void;

export type {
  AuthError,
  AuthErrorCode,
  AuthState,
  AuthStatus,
  AuthUser,
  SignInResult,
  Unsubscribe,
};
