import {
  ERROR_CODES,
  hasErrorCode,
  isApiError,
  isRateLimited,
} from "@handijit/core/errors";

import createAuthError from "../shared/create-auth-error.helper";
import type { AuthError } from "../types";

/** The backend's refusal of a proven code for an account that cannot sign in to a program. */
const DESKTOP_ACCOUNT_NOT_ALLOWED = "DESKTOP_ACCOUNT_NOT_ALLOWED";

/** Turns what the API client rejected with into the error a screen can show. */
const toAuthError = (error: unknown): AuthError => {
  if (hasErrorCode(error, ERROR_CODES.DESKTOP_CODE_INVALID)) {
    return createAuthError("CODE_REFUSED");
  }
  // The code was right but the account cannot use a program (not a verified customer account).
  if (hasErrorCode(error, DESKTOP_ACCOUNT_NOT_ALLOWED)) {
    return createAuthError("NOT_A_CUSTOMER");
  }
  if (isRateLimited(error)) {
    return createAuthError("RATE_LIMITED", error.retryAfterSeconds);
  }
  if (
    isApiError(error) &&
    (error.kind === "network" || error.kind === "timeout")
  ) {
    return createAuthError("OFFLINE");
  }
  return createAuthError("UNEXPECTED");
};

export default toAuthError;
