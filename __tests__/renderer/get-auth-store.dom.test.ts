import { afterEach, describe, expect, test } from "vitest";

import getAuthStore from "../../lib/renderer/get-auth-store";
import installBridge, { forgetStore } from "../support/fake-bridge";

const USER = { id: 41, email: "ayse@example.com", name: "Ayşe Yılmaz" };
const SIGNED_IN = {
  status: "signed-in",
  user: USER,
  error: null,
  isRemembered: true,
};

const settle = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0));
};

afterEach(forgetStore);

describe("getAuthStore", () => {
  test("should answer with the same store every time", () => {
    installBridge();
    expect(getAuthStore()).toBe(getAuthStore());
  });

  test("should share the store with another copy of the package on the page", () => {
    installBridge();
    const store = getAuthStore();
    const holder = globalThis as Record<symbol, unknown>;

    // The registry symbol is what a second bundle of this package would look under.
    expect(holder[Symbol.for("@handijit/auth:store")]).toBe(store);
  });

  test("should be callable before the page has a bridge, and connect when it is used", async () => {
    const store = getAuthStore();
    expect(store.getState().status).toBe("loading");

    const bridge = installBridge(SIGNED_IN);
    store.subscribe(() => undefined);
    await settle();

    expect(store.getState()).toEqual(SIGNED_IN);
    expect(bridge.calls).toEqual(["auth:get-state"]);
  });

  test("should fail loudly when the preload did not expose the bridge", () => {
    const store = getAuthStore();
    expect(() => store.subscribe(() => undefined)).toThrow(
      "on: window.desktop is missing; call exposeBridge() in the preload script of this window"
    );
  });

  test("should name the channel the preload left out", () => {
    installBridge();
    const desktop = (globalThis as unknown as { desktop: { on: object } })
      .desktop;
    desktop.on = {};

    expect(() => getAuthStore().subscribe(() => undefined)).toThrow(
      'on: channel "auth:changed" is not exposed by the preload; add it to the contract passed to exposeBridge()'
    );
  });

  test("should talk to main through the bridge: the state, the event and the three actions", async () => {
    const bridge = installBridge();
    bridge.answer("auth:sign-in", () => ({ ok: true, user: USER }));
    const store = getAuthStore();
    store.subscribe(() => undefined);
    await settle();

    expect(await store.signIn()).toEqual({ ok: true, user: USER });
    bridge.emit(SIGNED_IN);
    expect(store.getState()).toEqual(SIGNED_IN);
    await store.cancelSignIn();
    await store.signOut();

    expect(bridge.calls).toEqual([
      "auth:get-state",
      "auth:sign-in",
      "auth:cancel-sign-in",
      "auth:sign-out",
    ]);
    expect(bridge.subscriptions()).toBe(1);
  });
});
