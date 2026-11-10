import {
  ERROR_CODES,
  hasErrorCode,
  isApiError,
  isRateLimited,
} from "@handijit/core/errors";

import createAuthError from "../shared/create-auth-error.helper";
import type { AuthError } from "../types";

/** Turns what the API client rejected with into the error a screen can show. */
const toAuthError = (error: unknown): AuthError => {
  if (hasErrorCode(error, ERROR_CODES.DESKTOP_CODE_INVALID)) {
    return createAuthError("CODE_REFUSED");
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
