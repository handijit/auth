// The shared entry: the contract fragment with its schemas, the constants and the types.
// It imports `zod` and nothing else, so main and anything that composes a contract can load it.
// A preload and a page take what they need from `/preload`, `/renderer` and `/react` instead,
// which carry no Zod.
import AUTH_CHANNELS from "./shared/auth-channels.constants";
import {
  authContract,
  authErrorSchema,
  authStateSchema,
  authUserSchema,
  signInResultSchema,
} from "./shared/auth-contract";
import AUTH_ERROR_CODES from "./shared/auth-error-codes.constants";
import authErrorMessage from "./shared/auth-error-message";
import AUTH_STATUSES from "./shared/auth-statuses.constants";

export {
  AUTH_CHANNELS,
  AUTH_ERROR_CODES,
  AUTH_STATUSES,
  authContract,
  authErrorMessage,
  authErrorSchema,
  authStateSchema,
  authUserSchema,
  signInResultSchema,
};
export type { AuthContract } from "./shared/auth-contract";
export type {
  AuthError,
  AuthErrorCode,
  AuthState,
  AuthStatus,
  AuthUser,
  SignInResult,
  Unsubscribe,
} from "./types";
