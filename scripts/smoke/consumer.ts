import { z } from "zod";
import {
  AUTH_CHANNELS,
  authContract,
  authErrorMessage,
  type AuthContract,
  type AuthErrorCode,
  type AuthState,
  type SignInResult,
} from "@handijit/auth";
import {
  createAuth,
  type Auth,
  type AuthClient,
  type AuthOptions,
} from "@handijit/auth/main";
import { AUTH_CHANNELS as PRELOAD_CHANNELS } from "@handijit/auth/preload";
import { useAuth, type UseAuth } from "@handijit/auth/react";
import { getAuthStore, type AuthStore } from "@handijit/auth/renderer";
import { defineContract } from "@handijit/electron";
import {
  startApp,
  type AppContext,
  type Handlers,
} from "@handijit/electron/main";
import { exposeBridge, type ChannelMap } from "@handijit/electron/preload";

// shared: the app's contract with the fragment in it
const contract = defineContract({
  invoke: {
    ...authContract.invoke,
    "notes:list": { output: z.array(z.object({ id: z.number() })) },
  },
  events: { ...authContract.events },
});
type AppContract = typeof contract;

// main
const options: AuthOptions = { product: "notlar" };
const auth: Auth = createAuth(options);
const client: AuthClient = auth.client;
const handlers = (): Handlers<AppContract> => ({
  ...auth.handlers,
  "notes:list": async () => {
    await client.request({ method: "GET", path: "/api/customer", auth: true });
    return [{ id: 1 }];
  },
});
const started: Promise<AppContext<AppContract> | null> = startApp({
  contract,
  handlers,
  rendererRoot: "/app/renderer",
  window: { preload: "/app/preload.cjs" },
  beforeWindow: (context) => {
    const detach: () => void = auth.attach(context);
    void detach;
  },
});
const state: AuthState = auth.getState();
const result: Promise<SignInResult> = auth.signIn();
const authHandlers: Handlers<AuthContract> = auth.handlers;

// preload: the Zod-free channel list must be exactly the contract's channels
const channels: ChannelMap<AppContract> = {
  invoke: { ...PRELOAD_CHANNELS.invoke, "notes:list": true },
  events: { ...AUTH_CHANNELS.events },
};
exposeBridge(channels);
const incomplete: ChannelMap<AppContract> = {
  // @ts-expect-error the program's own channel is missing
  invoke: { ...PRELOAD_CHANNELS.invoke },
  events: { ...AUTH_CHANNELS.events },
};
void incomplete;

// renderer
const store: AuthStore = getAuthStore();
const stop: () => void = store.subscribe(() => undefined);
const status: AuthState["status"] = store.getState().status;
const hook: () => UseAuth = useAuth;
const code: AuthErrorCode = "SESSION_ENDED";
const sentence: string = authErrorMessage(code);

// @ts-expect-error the calls that move the session are not on the client
void client.refresh({ refreshToken: "x" });
// @ts-expect-error the calls that move the session are not on the client
void client.exchangeDesktopCode;
// @ts-expect-error a session cannot be created without the program's slug
createAuth({});
// @ts-expect-error a state has no field for a token
void state.accessToken;
// @ts-expect-error an unknown error code must not compile
void authErrorMessage("EXPIRED");
// @ts-expect-error a subpath the package does not export must not resolve
import("@handijit/auth/main/create-auth");

export {
  authHandlers,
  hook,
  result,
  sentence,
  started,
  state,
  status,
  stop,
  store,
};
