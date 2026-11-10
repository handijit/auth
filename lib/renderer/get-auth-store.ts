import type { Contract } from "@handijit/electron";
import { createClient } from "@handijit/electron/renderer";

import createAuthStore from "./create-auth-store";
import type { AuthStore } from "./create-auth-store";

// One store per page, whichever copy of this package asks: the renderer and React entries are
// separate bundles, and an app may load both the ESM and the CommonJS build. The registry
// symbol is the same in all of them.
const STORE_KEY = Symbol.for("@handijit/auth:store");

type StoreHolder = { [STORE_KEY]?: AuthStore };

/**
 * The page's session store, created on first use. It talks to main through `window.desktop`
 * (the bridge of `@handijit/electron`), which it reads only when it connects, so this can be
 * called before the page has one.
 */
const getAuthStore = (): AuthStore => {
  const holder = globalThis as StoreHolder;
  const existing = holder[STORE_KEY];
  if (existing !== undefined) return existing;

  // The channels are checked against the bridge by name at call time; their payloads are
  // checked by the store itself, so the client needs no schema types here.
  const client = createClient<Contract>();
  const store = createAuthStore({
    invoke: (channel) => client.invoke(channel),
    on: (channel, listener) => client.on(channel, listener),
  });
  holder[STORE_KEY] = store;
  return store;
};

export default getAuthStore;
