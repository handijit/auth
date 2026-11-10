import { vi } from "vitest";

import type { AuthState } from "../../lib/types";

// The stand-in for `window.desktop` in the page tests: the same shape `exposeBridge` of
// @handijit/electron gives a page (one function per channel), with a main process a test can
// steer. The client that reads it (`createClient`) is the real one.

type Channel =
  "auth:get-state" | "auth:sign-in" | "auth:cancel-sign-in" | "auth:sign-out";

type FakeBridge = {
  /** The channels the page called, in order. */
  readonly calls: Channel[];
  /** How many listeners the page has on `auth:changed` right now. */
  readonly listenerCount: () => number;
  /** How often the page subscribed to `auth:changed`. */
  readonly subscriptions: () => number;
  /** Main sends a state to the page. */
  readonly emit: (payload: unknown) => void;
  /** Sets what main answers on a channel from now on. */
  readonly answer: (channel: Channel, handler: () => unknown) => void;
  /** Makes main answer a channel only when the returned function is called. */
  readonly hold: (channel: Channel) => (value: unknown) => void;
};

const SIGNED_OUT: AuthState = {
  status: "signed-out",
  user: null,
  error: null,
  isRemembered: false,
};

/** Puts a bridge on the page. The test setup removes it again (`unstubGlobals`). */
const installBridge = (initial: unknown = SIGNED_OUT): FakeBridge => {
  const calls: Channel[] = [];
  const listeners = new Set<(payload: unknown) => void>();
  let subscriptions = 0;
  const handlers: Record<Channel, () => unknown> = {
    "auth:get-state": () => initial,
    "auth:sign-in": () => ({
      ok: false,
      error: { code: "SIGN_IN_CANCELLED", message: "Giriş iptal edildi." },
    }),
    "auth:cancel-sign-in": () => undefined,
    "auth:sign-out": () => undefined,
  };

  const invoke = Object.fromEntries(
    (Object.keys(handlers) as Channel[]).map((channel) => [
      channel,
      async () => {
        calls.push(channel);
        return handlers[channel]();
      },
    ])
  );

  vi.stubGlobal("desktop", {
    invoke,
    on: {
      "auth:changed": (listener: (payload: unknown) => void) => {
        subscriptions += 1;
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
  });

  return {
    calls,
    listenerCount: () => listeners.size,
    subscriptions: () => subscriptions,
    emit: (payload) => {
      for (const listener of [...listeners]) listener(payload);
    },
    answer: (channel, handler) => {
      handlers[channel] = handler;
    },
    hold: (channel) => {
      let release!: (value: unknown) => void;
      const held = new Promise<unknown>((resolve) => {
        release = resolve;
      });
      handlers[channel] = () => held;
      return release;
    },
  };
};

/** Forgets the page's store, as a page that was reloaded. */
const forgetStore = (): void => {
  delete (globalThis as Record<symbol, unknown>)[
    Symbol.for("@handijit/auth:store")
  ];
};

export type { FakeBridge };
export { forgetStore };
export default installBridge;
