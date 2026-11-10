import { useMemo, useSyncExternalStore } from "react";

import getAuthStore from "../renderer/get-auth-store";
import type { AuthState, SignInResult } from "../types";

/** What `useAuth` returns: the state of the session and the three actions. */
type UseAuth = AuthState & {
  /** Starts the sign-in in the browser. Resolves with the outcome; never rejects. */
  readonly signIn: () => Promise<SignInResult>;
  /** Cancels the sign-in that is waiting for the browser. */
  readonly cancelSignIn: () => Promise<void>;
  /** Signs out. */
  readonly signOut: () => Promise<void>;
};

/**
 * The session in a component. Every component shares the page's one store, so the hook can be
 * used anywhere without a provider. The first render is `loading`, never a `signed-out` that
 * flips a moment later; the returned object keeps its identity until the state changes.
 */
const useAuth = (): UseAuth => {
  const store = getAuthStore();
  const state = useSyncExternalStore(
    store.subscribe,
    store.getState,
    store.getState
  );
  return useMemo(
    () => ({
      ...state,
      signIn: store.signIn,
      cancelSignIn: store.cancelSignIn,
      signOut: store.signOut,
    }),
    [state, store]
  );
};

export type { UseAuth };
export default useAuth;
