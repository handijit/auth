// The renderer entry: no `electron`, no `node:*`, no Zod, no framework. Everything goes through
// `window.desktop`, the bridge of `@handijit/electron`.
import getAuthStore from "./renderer/get-auth-store";
import authErrorMessage from "./shared/auth-error-message";

export { authErrorMessage, getAuthStore };
export type { AuthStore } from "./renderer/create-auth-store";
export type {
  AuthError,
  AuthErrorCode,
  AuthState,
  AuthStatus,
  AuthUser,
  SignInResult,
  Unsubscribe,
} from "./types";
