import { createApiClient } from "@handijit/core";
import type { ApiClient, AuthSession, FetchLike } from "@handijit/core";
import { isUnauthorized } from "@handijit/core/errors";
import {
  codeChallengeOf,
  createCodeVerifier,
  createState,
} from "@handijit/core/pkce";
import { createSecretStore } from "@handijit/electron/main";
import type { Handlers, SecretStore } from "@handijit/electron/main";
import { app, net, shell } from "electron";

import type { AuthContract } from "../shared/auth-contract";
import {
  LOADING_STATE,
  SIGNED_OUT_STATE,
} from "../shared/auth-states.constants";
import createAuthError from "../shared/create-auth-error.helper";
import type {
  AuthError,
  AuthErrorCode,
  AuthState,
  AuthUser,
  SignInResult,
  Unsubscribe,
} from "../types";
import startLoopbackListener from "./loopback-listener";
import type { LoopbackListener } from "./loopback-listener";
import { buildSignInUrl, readPanelBaseUrl } from "./panel-url";
import reasonOf from "./reason-of.helper";
import createSessionVault from "./session-vault";
import type { AuthLogger, SessionVault } from "./session-vault";
import toAuthError from "./to-auth-error.helper";
import buildUserAgent from "./user-agent";

/** The backend's rule for a program's slug. */
const PRODUCT_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_PRODUCT_LENGTH = 64;
/** Long enough to sign up, verify an e-mail address and come back. */
const DEFAULT_SIGN_IN_TIMEOUT_MS = 10 * 60 * 1000;
/** An access token is treated as expired this long before it is, so a request never leaves with one that dies on the way. */
const ACCESS_TOKEN_SKEW_MS = 30_000;
/** A sign-out does not wait longer than this for the backend. */
const SIGN_OUT_TIMEOUT_MS = 5_000;

/** The calls of the API client that only this package may make. */
const SESSION_CALLS = ["exchangeDesktopCode", "refresh", "logout"] as const;

const SILENT_LOGGER: AuthLogger = {
  info: () => undefined,
  warn: () => undefined,
};

/**
 * The API client bound to the session, for the rest of the main process. The three calls that
 * would move the session behind this package's back are left out, of the type and of the object.
 */
type AuthClient = Omit<ApiClient, (typeof SESSION_CALLS)[number]>;

/** The part of the `AppContext` of `@handijit/electron` that `attach` uses. */
type AuthHost = {
  /** Sends the state to every window. */
  readonly emitter: {
    readonly broadcast: (
      channel: "auth:changed",
      payload: AuthState
    ) => unknown;
  };
  /** Brings the program's window to the front. */
  readonly showWindow: () => unknown;
};

/** How `createAuth` is set up. Only `product` is required. */
type AuthOptions = {
  /** The program's slug at the backend, e.g. `notlar`. */
  readonly product: string;
  /** Where the API lives. Default: `https://api.handijit.com`. */
  readonly apiBaseUrl?: string;
  /** Where the site with the consent page lives. Default: `https://www.handijit.com`. */
  readonly panelBaseUrl?: string;
  /** The `User-Agent` the backend stores as the device name. Default: `<product>/<version> (<OS> <version>; <arch>)`. */
  readonly userAgent?: string;
  /** The `fetch` to send with. Default: Electron's `net.fetch`. */
  readonly fetch?: FetchLike;
  /** Opens the consent page. Default: `shell.openExternal`. */
  readonly openBrowser?: (url: string) => void | Promise<void>;
  /** How long a sign-in waits for the browser, in milliseconds. Default: 600000 (ten minutes). */
  readonly signInTimeoutMs?: number;
  /** Called when the browser has come back: the moment to bring the window to the front. */
  readonly onCallback?: () => void;
  /** Where the session is kept. Default: `createSecretStore()` of `@handijit/electron`. */
  readonly secretStore?: SecretStore;
  /** A fixed loopback port (1024–65535). Default: the operating system picks a free one. */
  readonly port?: number;
  /** Where problems are reported. Never receives a token, a code or a `state`. Default: silent. */
  readonly logger?: AuthLogger;
};

/** The session of one installation: the only holder of its tokens. */
type Auth = {
  /** The API client that sends the access token and renews the session; pass `auth: true` to `request`. */
  readonly client: AuthClient;
  /** The handlers of `authContract`; spread them into the app's handlers. */
  readonly handlers: Handlers<AuthContract>;
  /** The current state. `loading` until `restore` has finished. */
  readonly getState: () => AuthState;
  /** Calls the listener after every change of the state. Returns the function that stops it. */
  readonly onChange: (listener: (state: AuthState) => void) => Unsubscribe;
  /** Reads the stored session, once; later calls answer with the current state. Never rejects. */
  readonly restore: () => Promise<AuthState>;
  /** Signs in with the browser. A second call while one is waiting reopens the same page. Never rejects. */
  readonly signIn: () => Promise<SignInResult>;
  /** Ends a waiting sign-in with `SIGN_IN_CANCELLED`. Does nothing when none is waiting. */
  readonly cancelSignIn: () => void;
  /** Signs out: wipes the session here, then tells the backend (best effort). Never rejects. */
  readonly signOut: () => Promise<void>;
  /**
   * Wires the session to a running app: every change is broadcast as `auth:changed`, the window
   * comes to the front when the browser returns, and the stored session is read. Call it in
   * `beforeWindow` of `startApp`. Returns the function that undoes the wiring.
   */
  readonly attach: (host: AuthHost) => Unsubscribe;
  /** Cancels a waiting sign-in, closes the listener and drops every listener. For a shutdown and for tests. */
  readonly dispose: () => Promise<void>;
};

type Adoption =
  | { readonly kind: "adopted"; readonly user: AuthUser }
  | { readonly kind: "stale" }
  | { readonly kind: "not-a-customer" };

/**
 * Creates the session of this installation. Create one per program, in the main process, and
 * keep it for the life of the process: it owns the API client, the refresh token and the
 * loopback listener. Nothing happens until `restore`, `attach` or `signIn` is called.
 *
 * Throws a `TypeError` for an option that is wrong.
 */
const createAuth = (options: AuthOptions): Auth => {
  const { product } = options;
  if (
    typeof product !== "string" ||
    product.length > MAX_PRODUCT_LENGTH ||
    !PRODUCT_PATTERN.test(product)
  ) {
    throw new TypeError(
      `createAuth: options.product must be the program's slug (a-z, 0-9 and "-", at most ${MAX_PRODUCT_LENGTH} characters), received ${JSON.stringify(product)}`
    );
  }
  const panelBaseUrl = readPanelBaseUrl(options.panelBaseUrl);
  const signInTimeoutMs = options.signInTimeoutMs ?? DEFAULT_SIGN_IN_TIMEOUT_MS;
  if (!Number.isFinite(signInTimeoutMs) || signInTimeoutMs <= 0) {
    throw new TypeError(
      `createAuth: options.signInTimeoutMs must be a number of milliseconds above zero, received ${String(signInTimeoutMs)}`
    );
  }
  const logger = options.logger ?? SILENT_LOGGER;
  const openBrowser =
    options.openBrowser ?? ((url: string) => shell.openExternal(url));

  let state: AuthState = LOADING_STATE;
  const listeners = new Set<(state: AuthState) => void>();
  const callbackHooks = new Set<() => void>();
  if (options.onCallback !== undefined) callbackHooks.add(options.onCallback);

  // The session. `epoch` moves whenever it ends, so that an answer which arrives afterwards
  // (a refresh, an exchange) knows it is too late to be adopted.
  let epoch = 0;
  let refreshToken: string | null = null;
  let accessToken: { value: string; expiresAt: number } | null = null;
  let vault!: SessionVault;
  let restoring: Promise<void> | null = null;
  let refreshing: Promise<boolean> | null = null;

  // The sign-in that is waiting, if any. There is never a second one.
  let pendingSignIn: Promise<SignInResult> | null = null;
  let pendingUrl: string | null = null;
  let isCancelRequested = false;
  let wake: (() => void) | null = null;
  let listener: LoopbackListener | null = null;

  const setState = (next: AuthState): void => {
    state = next;
    for (const listen of [...listeners]) {
      try {
        listen(next);
      } catch (error) {
        logger.warn("A listener of the session state failed", {
          reason: reasonOf(error),
        });
      }
    }
  };

  const api = createApiClient({
    baseUrl: options.apiBaseUrl,
    // Read when a request is sent, not now: `net` works only once the app is ready.
    fetch: options.fetch ?? ((url, init) => net.fetch(url, init)),
    userAgent:
      options.userAgent ??
      buildUserAgent({
        product,
        version: app.getVersion(),
        platform: process.platform,
        systemVersion: process.getSystemVersion(),
        arch: process.arch,
      }),
    getAccessToken: () =>
      accessToken !== null && Date.now() < accessToken.expiresAt
        ? accessToken.value
        : undefined,
    refreshSession: async () => {
      await restore();
      return refreshOnce();
    },
  });
  // What the rest of the program gets: everything but the three calls that move the session.
  const client = Object.fromEntries(
    Object.entries(api).filter(
      ([name]) => !(SESSION_CALLS as readonly string[]).includes(name)
    )
  ) as AuthClient;

  // Best effort: the session here is already gone whatever the backend says.
  const revoke = async (token: string): Promise<void> => {
    try {
      await api.logout(
        { refreshToken: token },
        { timeoutMs: SIGN_OUT_TIMEOUT_MS }
      );
    } catch (error) {
      logger.info("The backend could not be told that the session is over", {
        reason: reasonOf(error),
      });
    }
  };

  const endSession = async (code: AuthErrorCode): Promise<void> => {
    epoch += 1;
    refreshToken = null;
    accessToken = null;
    setState({ ...SIGNED_OUT_STATE, error: createAuthError(code) });
    await vault.clear();
  };

  // Takes a session the backend has just answered with. Both tokens are in place, in memory
  // and on the disk, before this resolves.
  const adopt = async (
    session: AuthSession,
    startedAt: number
  ): Promise<Adoption> => {
    // A sign-out while the request was on its way: the new session must not outlive it.
    if (epoch !== startedAt) {
      await revoke(session.refreshToken);
      return { kind: "stale" };
    }
    // The backend answers a sign-in for a customer only; this is the same rule held here too.
    if (session.user.role !== "CUSTOMER") {
      await revoke(session.refreshToken);
      return { kind: "not-a-customer" };
    }
    const { id, email, name } = session.user;
    const user: AuthUser = { id, email, name };
    const lifetimeMs = session.expiresInSeconds * 1000;
    refreshToken = session.refreshToken;
    accessToken = {
      value: session.accessToken,
      expiresAt:
        Date.now() +
        lifetimeMs -
        Math.min(ACCESS_TOKEN_SKEW_MS, lifetimeMs / 2),
    };
    const isRemembered = await vault.save({
      refreshToken: session.refreshToken,
      user,
    });
    if (epoch !== startedAt) {
      await revoke(session.refreshToken);
      return { kind: "stale" };
    }
    setState({ status: "signed-in", user, error: null, isRemembered });
    return { kind: "adopted", user };
  };

  const runRefresh = async (): Promise<boolean> => {
    const token = refreshToken;
    if (token === null) return false;
    const startedAt = epoch;
    let session: AuthSession;
    try {
      session = await api.refresh({ refreshToken: token });
    } catch (error) {
      // Only the backend's refusal ends the session. No network, a timeout or an answer that
      // cannot be read say nothing about it: they are thrown, and the customer stays signed in.
      if (!isUnauthorized(error)) throw error;
      if (epoch === startedAt) await endSession("SESSION_ENDED");
      return false;
    }
    const adoption = await adopt(session, startedAt);
    if (adoption.kind === "not-a-customer") {
      await endSession("NOT_A_CUSTOMER");
    }
    return adoption.kind === "adopted";
  };

  // Single flight. The backend rotates the refresh token and accepts the retired one only once
  // within a short grace period; two refreshes in parallel would still waste that one chance
  // and could end the session, so one refresh runs at a time.
  const refreshOnce = (): Promise<boolean> => {
    refreshing ??= runRefresh().finally(() => {
      refreshing = null;
    });
    return refreshing;
  };

  const runRestore = async (): Promise<void> => {
    // The secret store reads nothing before the app is ready, which would look like "signed out".
    await app.whenReady();
    vault = createSessionVault({
      secretStore: options.secretStore ?? createSecretStore(),
      logger,
    });
    const stored = await vault.load();
    if (stored === null) {
      setState(SIGNED_OUT_STATE);
      return;
    }
    refreshToken = stored.refreshToken;
    setState({
      status: "signed-in",
      user: stored.user,
      error: null,
      isRemembered: true,
    });
    // The customer is shown as signed in at once; the backend is asked in the background. Only
    // its refusal signs them out: a program that starts without a network stays signed in.
    refreshOnce().catch((error: unknown) => {
      logger.info(
        "The stored session could not be checked with the backend; staying signed in",
        { reason: reasonOf(error) }
      );
    });
  };

  const restore = async (): Promise<AuthState> => {
    restoring ??= runRestore();
    await restoring;
    return state;
  };

  const fail = (error: AuthError): SignInResult => {
    setState({ ...SIGNED_OUT_STATE, error });
    return { ok: false, error };
  };

  // A cancel is the customer's own choice: it is answered, but it is not an error to show.
  const cancelled = (): SignInResult => {
    if (state.status === "signing-in") setState(SIGNED_OUT_STATE);
    return { ok: false, error: createAuthError("SIGN_IN_CANCELLED") };
  };

  const open = async (url: string): Promise<boolean> => {
    try {
      await openBrowser(url);
      return true;
    } catch (error) {
      logger.warn("The browser could not be opened", {
        reason: reasonOf(error),
      });
      return false;
    }
  };

  // Opens the consent page and waits for the browser, the time limit or a cancel.
  const waitForCode = async (
    current: LoopbackListener,
    url: string
  ): Promise<string | AuthErrorCode> => {
    // A cancel that came while the listener was starting: the browser is not opened at all.
    if (isCancelRequested) return "SIGN_IN_CANCELLED";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const interrupted = new Promise<AuthErrorCode>((resolve) => {
      timer = setTimeout(() => resolve("SIGN_IN_TIMED_OUT"), signInTimeoutMs);
      wake = () => resolve("SIGN_IN_CANCELLED");
      // Not awaited: an opener that never answers must not outlast the time limit or a cancel.
      void open(url).then((isOpen) => {
        if (!isOpen) resolve("BROWSER_NOT_OPENED");
      });
    });
    pendingUrl = url;
    try {
      const outcome = await Promise.race([current.outcome, interrupted]);
      if (typeof outcome === "string") return outcome;
      return outcome.kind === "code" ? outcome.code : "STATE_MISMATCH";
    } finally {
      clearTimeout(timer);
      wake = null;
      pendingUrl = null;
    }
  };

  const runSignIn = async (): Promise<SignInResult> => {
    await restore();
    if (state.status === "signed-in" && state.user !== null) {
      return { ok: true, user: state.user };
    }
    if (isCancelRequested) return cancelled();

    const startedAt = epoch;
    setState({ ...SIGNED_OUT_STATE, status: "signing-in" });

    const codeVerifier = createCodeVerifier();
    const attemptState = createState();
    let codeChallenge: string;
    let current: LoopbackListener;
    try {
      codeChallenge = await codeChallengeOf(codeVerifier);
      // The listener of the previous attempt may still be serving its page.
      await listener?.close();
      current = await startLoopbackListener({
        state: attemptState,
        port: options.port,
      });
    } catch (error) {
      logger.warn("The loopback listener could not be started", {
        reason: reasonOf(error),
      });
      return fail(createAuthError("LISTENER_FAILED"));
    }
    listener = current;

    const waited = await waitForCode(
      current,
      buildSignInUrl({
        panelBaseUrl,
        product,
        codeChallenge,
        redirectUri: current.redirectUri,
        state: attemptState,
      })
    );
    if (waited === "SIGN_IN_CANCELLED") {
      await current.close();
      return cancelled();
    }
    if (
      waited === "SIGN_IN_TIMED_OUT" ||
      waited === "STATE_MISMATCH" ||
      waited === "BROWSER_NOT_OPENED"
    ) {
      await current.close();
      return fail(createAuthError(waited));
    }

    // The browser is back. The listener closes by itself once it has served its page.
    for (const hook of [...callbackHooks]) {
      try {
        hook();
      } catch (error) {
        logger.warn("The callback hook failed", { reason: reasonOf(error) });
      }
    }

    let session: AuthSession;
    try {
      // Once. The backend consumes the code on the first attempt, whatever the outcome.
      session = await api.exchangeDesktopCode({
        code: waited,
        codeVerifier,
        redirectUri: current.redirectUri,
      });
    } catch (error) {
      if (isCancelRequested) return cancelled();
      logger.warn("The sign-in code could not be exchanged", {
        reason: reasonOf(error),
      });
      return fail(toAuthError(error));
    }
    if (isCancelRequested) {
      await revoke(session.refreshToken);
      return cancelled();
    }

    const adoption = await adopt(session, startedAt);
    if (adoption.kind === "adopted") return { ok: true, user: adoption.user };
    return adoption.kind === "not-a-customer"
      ? fail(createAuthError("NOT_A_CUSTOMER"))
      : cancelled();
  };

  const signIn = (): Promise<SignInResult> => {
    if (pendingSignIn !== null) {
      // The customer lost the tab: the same page again, on the same listener.
      if (pendingUrl !== null) void open(pendingUrl);
      return pendingSignIn;
    }
    isCancelRequested = false;
    const run = runSignIn().finally(() => {
      pendingSignIn = null;
    });
    pendingSignIn = run;
    return run;
  };

  const cancelSignIn = (): void => {
    if (pendingSignIn === null) return;
    isCancelRequested = true;
    wake?.();
  };

  const signOut = async (): Promise<void> => {
    cancelSignIn();
    await restore();
    const token = refreshToken;
    const pendingRefresh = refreshing;
    epoch += 1;
    refreshToken = null;
    accessToken = null;
    if (state !== SIGNED_OUT_STATE) setState(SIGNED_OUT_STATE);
    await vault.clear();
    if (token === null) return;
    if (pendingRefresh !== null) {
      try {
        // A refresh that answers after this point revokes the session it was given.
        await pendingRefresh;
        return;
      } catch {
        // It got no answer, so the token read above may still be the live one.
      }
    }
    await revoke(token);
  };

  const onChange = (listen: (state: AuthState) => void): Unsubscribe => {
    listeners.add(listen);
    return () => {
      listeners.delete(listen);
    };
  };

  const attach = (host: AuthHost): Unsubscribe => {
    const stop = onChange((next) => {
      host.emitter.broadcast("auth:changed", next);
    });
    const focus = (): void => {
      host.showWindow();
      // The browser is the active application at this moment; on macOS a window that asks for
      // focus stays behind it unless the app takes it.
      app.focus({ steal: true });
    };
    callbackHooks.add(focus);
    void restore();
    return () => {
      stop();
      callbackHooks.delete(focus);
    };
  };

  const dispose = async (): Promise<void> => {
    cancelSignIn();
    listeners.clear();
    callbackHooks.clear();
    await pendingSignIn;
    await listener?.close();
  };

  return {
    client,
    handlers: {
      "auth:get-state": () => restore(),
      "auth:sign-in": () => signIn(),
      "auth:cancel-sign-in": () => cancelSignIn(),
      "auth:sign-out": () => signOut(),
    },
    getState: () => state,
    onChange,
    restore,
    signIn,
    cancelSignIn,
    signOut,
    attach,
    dispose,
  };
};

export type { Auth, AuthClient, AuthHost, AuthOptions };
export default createAuth;
