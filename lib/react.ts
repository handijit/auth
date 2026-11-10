// The React entry: the renderer entry's store as a hook. React is an optional peer; a program
// without it uses `/renderer` and never loads this file.
import useAuth from "./react/use-auth";

export { useAuth };
export type { UseAuth } from "./react/use-auth";
export type {
  AuthError,
  AuthErrorCode,
  AuthState,
  AuthStatus,
  AuthUser,
  SignInResult,
} from "./types";
