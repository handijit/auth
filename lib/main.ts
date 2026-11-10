// The main-process entry. The only place that ever holds a token.
import createAuth from "./main/create-auth";

export { createAuth };
export type {
  Auth,
  AuthClient,
  AuthHost,
  AuthOptions,
} from "./main/create-auth";
export type { AuthLogger } from "./main/session-vault";
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
