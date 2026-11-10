import { describe, expect, test, vi } from "vitest";

import createAuthStore from "../../lib/renderer/create-auth-store";
import type { AuthIpc } from "../../lib/renderer/create-auth-store";
import type { AuthState } from "../../lib/types";

const LOADING: AuthState = {
  status: "loading",
  user: null,
  error: null,
  isRemembered: false,
};
const SIGNED_OUT: AuthState = { ...LOADING, status: "signed-out" };
const SIGNING_IN: AuthState = { ...LOADING, status: "signing-in" };
const USER = { id: 41, email: "ayse@example.com", name: "Ayşe Yılmaz" };
const SIGNED_IN: AuthState = {
  status: "signed-in",
  user: USER,
  error: null,
  isRemembered: true,
};
const UNEXPECTED = {
  code: "UNEXPECTED",
  message: "Giriş şu an tamamlanamadı. Biraz sonra yeniden deneyin.",
};

type Deferred = {
  promise: Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
};

const defer = (): Deferred => {
  let resolve!: (value: unknown) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<unknown>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

/** A main process a test answers for, one request at a time. */
const createIpc = (): {
  ipc: AuthIpc;
  calls: string[];
  pending: Record<string, Deferred[]>;
  emit: (payload: unknown) => void;
  listenerCount: () => number;
} => {
  const calls: string[] = [];
  const pending: Record<string, Deferred[]> = {};
  const listeners = new Set<(payload: unknown) => void>();
  return {
    ipc: {
      invoke: (channel) => {
        calls.push(channel);
        const deferred = defer();
        (pending[channel] ??= []).push(deferred);
        return deferred.promise;
      },
      on: (_channel, listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    calls,
    pending,
    emit: (payload) => {
      for (const listener of [...listeners]) listener(payload);
    },
    listenerCount: () => listeners.size,
  };
};

/** Lets the promise chains of the store run. */
const settle = async (): Promise<void> => {
  await new Promise((resolve) => setImmediate(resolve));
};

describe("createAuthStore: connecting", () => {
  test("should be loading and ask nothing until someone listens", () => {
    const main = createIpc();
    const store = createAuthStore(main.ipc);

    expect(store.getState()).toEqual(LOADING);
    expect(main.calls).toEqual([]);
    expect(main.listenerCount()).toBe(0);
  });

  test("should listen to the event first and ask for the state second, once", () => {
    const order: string[] = [];
    const store = createAuthStore({
      invoke: (channel) => {
        order.push(`invoke ${channel}`);
        return Promise.resolve(SIGNED_OUT);
      },
      on: (channel) => {
        order.push(`on ${channel}`);
        return () => undefined;
      },
    });

    store.subscribe(() => undefined);
    store.subscribe(() => undefined);
    store.subscribe(() => undefined);

    expect(order).toEqual(["on auth:changed", "invoke auth:get-state"]);
  });

  test("should take the state main answers with", async () => {
    const main = createIpc();
    const store = createAuthStore(main.ipc);
    const listener = vi.fn();
    store.subscribe(listener);

    main.pending["auth:get-state"]?.[0]?.resolve(SIGNED_IN);
    await settle();

    expect(store.getState()).toEqual(SIGNED_IN);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test("should keep the same state object until the state changes", async () => {
    const main = createIpc();
    const store = createAuthStore(main.ipc);
    store.subscribe(() => undefined);
    main.pending["auth:get-state"]?.[0]?.resolve(SIGNED_IN);
    await settle();

    expect(store.getState()).toBe(store.getState());
  });

  test("should believe an event that arrived before the answer: it is newer", async () => {
    const main = createIpc();
    const store = createAuthStore(main.ipc);
    const seen: string[] = [];
    store.subscribe(() => seen.push(store.getState().status));

    main.emit(SIGNED_IN);
    main.pending["auth:get-state"]?.[0]?.resolve(SIGNED_OUT);
    await settle();

    expect(store.getState()).toEqual(SIGNED_IN);
    expect(seen).toEqual(["signed-in"]);
  });

  test("should follow every event after the answer", async () => {
    const main = createIpc();
    const store = createAuthStore(main.ipc);
    const seen: string[] = [];
    store.subscribe(() => seen.push(store.getState().status));
    main.pending["auth:get-state"]?.[0]?.resolve(SIGNED_OUT);
    await settle();

    main.emit(SIGNING_IN);
    main.emit(SIGNED_IN);
    main.emit(SIGNED_OUT);

    expect(seen).toEqual([
      "signed-out",
      "signing-in",
      "signed-in",
      "signed-out",
    ]);
  });

  test("should connect on an action as well, so that its outcome is seen", async () => {
    const main = createIpc();
    const store = createAuthStore(main.ipc);

    void store.signIn();
    await settle();

    expect(main.calls).toEqual(["auth:get-state", "auth:sign-in"]);
    expect(main.listenerCount()).toBe(1);
  });

  test("should stay connected when the last listener leaves", async () => {
    const main = createIpc();
    const store = createAuthStore(main.ipc);
    const listener = vi.fn();
    const stop = store.subscribe(listener);
    main.pending["auth:get-state"]?.[0]?.resolve(SIGNED_OUT);
    await settle();
    stop();
    stop();

    main.emit(SIGNED_IN);
    store.subscribe(listener);

    // The removed listener heard nothing, and the state is current without a second question.
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getState()).toEqual(SIGNED_IN);
    expect(main.calls).toEqual(["auth:get-state"]);
  });

  test("should let a listener leave while the listeners are being called", async () => {
    const main = createIpc();
    const store = createAuthStore(main.ipc);
    const second = vi.fn();
    const stop = store.subscribe(() => stop());
    store.subscribe(second);

    main.emit(SIGNED_IN);
    main.emit(SIGNED_OUT);

    expect(second).toHaveBeenCalledTimes(2);
  });

  test("should fail loudly when the page has no bridge, and try again the next time", () => {
    let hasBridge = false;
    const store = createAuthStore({
      invoke: () => Promise.resolve(SIGNED_OUT),
      on: () => {
        if (!hasBridge) throw new Error("on: window.desktop is missing");
        return () => undefined;
      },
    });

    expect(() => store.subscribe(() => undefined)).toThrow(
      "on: window.desktop is missing"
    );
    hasBridge = true;
    expect(() => store.subscribe(() => undefined)).not.toThrow();
  });
});

describe("createAuthStore: what it does not believe", () => {
  test.each([
    ["nothing", undefined],
    ["null", null],
    ["a string", "signed-in"],
    ["an unknown status", { ...SIGNED_OUT, status: "expired" }],
    ["a user without an id", { ...SIGNED_IN, user: { email: "a", name: "b" } }],
    [
      "an unknown error code",
      { ...SIGNED_OUT, error: { code: "X", message: "" } },
    ],
    ["no isRemembered", { status: "signed-out", user: null, error: null }],
  ])("should ignore an event that carries %s", async (_name, payload) => {
    const main = createIpc();
    const store = createAuthStore(main.ipc);
    const listener = vi.fn();
    store.subscribe(listener);
    main.pending["auth:get-state"]?.[0]?.resolve(SIGNED_IN);
    await settle();

    main.emit(payload);

    expect(store.getState()).toEqual(SIGNED_IN);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test("should not count an event it ignored as news", async () => {
    const main = createIpc();
    const store = createAuthStore(main.ipc);
    store.subscribe(() => undefined);

    main.emit({ status: "signed-in" });
    main.pending["auth:get-state"]?.[0]?.resolve(SIGNED_OUT);
    await settle();

    expect(store.getState()).toEqual(SIGNED_OUT);
  });

  test("should be signed out with UNEXPECTED when the answer is not a state", async () => {
    const main = createIpc();
    const store = createAuthStore(main.ipc);
    store.subscribe(() => undefined);

    main.pending["auth:get-state"]?.[0]?.resolve({ status: "signed-in" });
    await settle();

    expect(store.getState()).toEqual({ ...SIGNED_OUT, error: UNEXPECTED });
  });

  test("should be signed out with UNEXPECTED when the question fails, not loading for ever", async () => {
    const main = createIpc();
    const store = createAuthStore(main.ipc);
    store.subscribe(() => undefined);

    main.pending["auth:get-state"]?.[0]?.reject(new Error("No handler"));
    await settle();

    expect(store.getState()).toEqual({ ...SIGNED_OUT, error: UNEXPECTED });
  });

  test("should recover with the next event after a failed question", async () => {
    const main = createIpc();
    const store = createAuthStore(main.ipc);
    store.subscribe(() => undefined);
    main.pending["auth:get-state"]?.[0]?.reject(new Error("No handler"));
    await settle();

    main.emit(SIGNED_IN);

    expect(store.getState()).toEqual(SIGNED_IN);
  });
});

describe("createAuthStore: actions", () => {
  test("should resolve signIn with main's answer", async () => {
    const main = createIpc();
    const store = createAuthStore(main.ipc);

    const result = store.signIn();
    await settle();
    main.pending["auth:sign-in"]?.[0]?.resolve({ ok: true, user: USER });

    expect(await result).toEqual({ ok: true, user: USER });
  });

  test("should resolve signIn with a failure as it came, seconds included", async () => {
    const main = createIpc();
    const store = createAuthStore(main.ipc);
    const failure = {
      ok: false,
      error: {
        code: "RATE_LIMITED",
        message: "Çok fazla deneme yapıldı.",
        retryAfterSeconds: 90,
      },
    };

    const result = store.signIn();
    await settle();
    main.pending["auth:sign-in"]?.[0]?.resolve(failure);

    expect(await result).toEqual(failure);
  });

  test.each([
    ["nothing", undefined],
    ["a user without ok", { user: USER }],
    ["ok without a user", { ok: true }],
    ["a failure without an error", { ok: false }],
    [
      "an error with negative seconds",
      {
        ok: false,
        error: { code: "RATE_LIMITED", message: "", retryAfterSeconds: -1 },
      },
    ],
  ])(
    "should resolve signIn with UNEXPECTED when main answers %s",
    async (_name, answer) => {
      const main = createIpc();
      const store = createAuthStore(main.ipc);

      const result = store.signIn();
      await settle();
      main.pending["auth:sign-in"]?.[0]?.resolve(answer);

      expect(await result).toEqual({ ok: false, error: UNEXPECTED });
    }
  );

  test("should resolve signIn with UNEXPECTED when the request fails", async () => {
    const main = createIpc();
    const store = createAuthStore(main.ipc);

    const result = store.signIn();
    await settle();
    main.pending["auth:sign-in"]?.[0]?.reject(new Error("No handler"));

    expect(await result).toEqual({ ok: false, error: UNEXPECTED });
  });

  test.each([
    ["cancelSignIn", "auth:cancel-sign-in"],
    ["signOut", "auth:sign-out"],
  ] as const)(
    "should send %s to main and resolve with nothing",
    async (action, channel) => {
      const main = createIpc();
      const store = createAuthStore(main.ipc);

      const done = store[action]();
      await settle();
      main.pending[channel]?.[0]?.resolve("ignored");

      expect(await done).toBeUndefined();
      expect(main.calls).toEqual(["auth:get-state", channel]);
    }
  );

  test.each([
    ["cancelSignIn", "auth:cancel-sign-in"],
    ["signOut", "auth:sign-out"],
  ] as const)(
    "should resolve %s even when the request fails",
    async (action, channel) => {
      const main = createIpc();
      const store = createAuthStore(main.ipc);

      const done = store[action]();
      await settle();
      main.pending[channel]?.[0]?.reject(new Error("No handler"));

      await expect(done).resolves.toBeUndefined();
    }
  );

  test("should not change the state by itself: main says what happened", async () => {
    const main = createIpc();
    const store = createAuthStore(main.ipc);
    store.subscribe(() => undefined);
    main.pending["auth:get-state"]?.[0]?.resolve(SIGNED_IN);
    await settle();

    const done = store.signOut();
    await settle();
    main.pending["auth:sign-out"]?.[0]?.resolve(undefined);
    await done;
    expect(store.getState()).toEqual(SIGNED_IN);

    main.emit(SIGNED_OUT);
    expect(store.getState()).toEqual(SIGNED_OUT);
  });
});
