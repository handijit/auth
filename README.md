# @handijit/auth

"Sign in with the browser" for Han Dijit's Electron desktop programs, and the session that
results. The program never asks for a password: it opens the panel's consent page in the
system browser, listens on a loopback port for the answer (RFC 8252 with PKCE, RFC 7636),
keeps the session in the operating system's secret store and hands the rest of the program an
API client that is already signed in.

It ships no visual component. The sign-in screen is the program's own; this package gives it
the state and the actions.

- **Five entry points, one per process.** `@handijit/auth/main`, `@handijit/auth/preload`,
  `@handijit/auth/renderer`, `@handijit/auth/react`, and `@handijit/auth` for what they share.
  A build check keeps each entry importing only what its process can load: the preload entry
  imports nothing at all, the renderer and React entries never touch `electron`, `node:*` or
  Zod.
- **Tokens never leave the main process.** The contract has no field for one, the state has no
  field for one, and the logger never receives one.
- **No runtime dependency.** `electron`, `@handijit/electron`, `@handijit/core` and `zod` are
  peer dependencies; `react` is an optional one.
- **ES modules and CommonJS**, with types for both.

## Install

```sh
npm install @handijit/auth @handijit/electron @handijit/core zod
npm install --save-dev electron
```

| Peer                 | Range                  | Why                                                                                      |
| -------------------- | ---------------------- | ---------------------------------------------------------------------------------------- |
| `electron`           | `>=43.0.0 <46.0.0`     | The range of `@handijit/electron`. The smoke test of this package ran on Electron 45.    |
| `@handijit/electron` | `^1.0.0`               | The secret store, the typed IPC contract and the bridge (`window.desktop`).              |
| `@handijit/core`     | `^1.0.0`               | Every API call and the PKCE pair. Nothing of either is reimplemented here.               |
| `zod`                | `^4.0.0`               | The schemas of the contract fragment.                                                    |
| `react` (optional)   | `^18.0.0 \|\| ^19.0.0` | Only for `@handijit/auth/react`. A program without React uses `@handijit/auth/renderer`. |

Node 24 or newer for the tooling. The main-process code runs on the Node that Electron embeds.

## Quick start

One fragment in the contract, then one small change in each of the three process files.

### 1. The contract (shared)

```ts
// src/shared/contract.ts
import { authContract } from "@handijit/auth";
import { defineContract } from "@handijit/electron";
import { z } from "zod";

export const contract = defineContract({
  invoke: {
    ...authContract.invoke,
    "notes:list": { output: z.array(z.object({ id: z.number() })) },
  },
  events: { ...authContract.events },
});
export type AppContract = typeof contract;
```

The fragment adds four requests (`auth:get-state`, `auth:sign-in`, `auth:cancel-sign-in`,
`auth:sign-out`) and one event (`auth:changed`). `@handijit/electron` validates every payload
with these schemas on the main side; the renderer entry checks what it receives again.

### 2. main

```ts
// src/main/index.ts
import { join } from "node:path";
import { createAuth } from "@handijit/auth/main";
import { startApp } from "@handijit/electron/main";
import { contract } from "../shared/contract";

// One per program, for the life of the process. Creating it does nothing yet.
export const auth = createAuth({ product: "notlar" });

await startApp({
  contract,
  handlers: ({ logger }) => ({
    ...auth.handlers,
    "notes:list": async () => {
      // `auth.client` is the API client of @handijit/core, already signed in.
      const user = await auth.client.getCurrentUser();
      logger.info("Listing notes", { userId: user.id });
      return [{ id: 1 }];
    },
  }),
  rendererRoot: join(import.meta.dirname, "../renderer"),
  window: { preload: join(import.meta.dirname, "../preload/index.cjs") },
  // Broadcasts every change as `auth:changed`, brings the window to the front when the
  // browser returns, and reads the stored session without holding the window back.
  beforeWindow: (context) => {
    auth.attach(context);
  },
});
```

### 3. preload

```ts
// src/preload/index.ts
import { AUTH_CHANNELS } from "@handijit/auth/preload";
import { exposeBridge, type ChannelMap } from "@handijit/electron/preload";
import type { AppContract } from "../shared/contract";

const channels: ChannelMap<AppContract> = {
  invoke: { ...AUTH_CHANNELS.invoke, "notes:list": true },
  events: { ...AUTH_CHANNELS.events },
};
exposeBridge(channels);
```

`@handijit/auth/preload` is the channel names and nothing else (0.3 kB gzipped, no import), so
the single CommonJS file a sandboxed preload has to be carries no Zod. Passing the whole
`contract` to `exposeBridge` works too, at the cost of Zod in the preload.

### 4. renderer

```tsx
// src/renderer/SignInScreen.tsx
import { useAuth } from "@handijit/auth/react";

export const SignInScreen = () => {
  const { status, user, error, signIn, cancelSignIn, signOut } = useAuth();

  if (status === "loading") return null;
  if (status === "signed-in") {
    return (
      <button onClick={() => void signOut()}>{user?.name}: Çıkış yap</button>
    );
  }
  return (
    <>
      {error && <p role="alert">{error.message}</p>}
      {/* While the browser is open the same button reopens the page for a lost tab. */}
      <button onClick={() => void signIn()}>Tarayıcıyla giriş yap</button>
      {status === "signing-in" && (
        <button onClick={() => void cancelSignIn()}>Vazgeç</button>
      )}
    </>
  );
};
```

No provider: every component that calls `useAuth()` shares the page's one store. Without
React, `getAuthStore()` from `@handijit/auth/renderer` is the same store with `getState` and
`subscribe`.

## What a sign-in does

1. `signIn()` makes a PKCE pair and a `state` (`@handijit/core/pkce`), starts a listener on
   `127.0.0.1` at a port the operating system picks, and opens
   `https://www.handijit.com/panel/masaustu-giris?product=…&code_challenge=…&redirect_uri=http://127.0.0.1:<port>/callback&state=…`
   in the system browser. The state becomes `signing-in`.
2. The customer signs in to the panel if needed and approves. The browser comes back to
   `/callback?code=…&state=…`.
3. The listener checks the `Host`, the path and the `state`, answers with a `303` to
   `/tamamlandi` (so the code is not left in the address bar or the history), serves the
   Turkish "Programa dönebilirsiniz" page there and closes.
4. The program's window comes to the front, the code is exchanged once at
   `POST /api/public/desktop/token`, both tokens are stored, and the state becomes `signed-in`.

The consent page reports neither a cancel nor an error to the program. The attempt ends on its
own after `signInTimeoutMs` (ten minutes by default) or when the program calls `cancelSignIn()`.

## API

### `@handijit/auth`: shared

| Export                                                                       | What it is                                                                                                         |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `authContract`                                                               | The contract fragment: `{ invoke, events }` with Zod schemas, to spread into `defineContract`.                     |
| `AUTH_CHANNELS`                                                              | The same channel names without Zod: `{ invoke: { "auth:get-state": true, … }, events: { "auth:changed": true } }`. |
| `authStateSchema`, `authUserSchema`, `authErrorSchema`, `signInResultSchema` | The schemas of the payloads.                                                                                       |
| `AUTH_STATUSES`                                                              | `["loading", "signed-out", "signing-in", "signed-in"]`                                                             |
| `AUTH_ERROR_CODES`                                                           | Every error code, see [Failures](#failures).                                                                       |
| `authErrorMessage(code, retryAfterSeconds?)`                                 | The Turkish sentence for a code.                                                                                   |

```ts
type AuthState = {
  status: "loading" | "signed-out" | "signing-in" | "signed-in";
  user: { id: number; email: string; name: string } | null; // set while signed in
  error: AuthError | null; // why the last sign-in failed or the session ended
  isRemembered: boolean; // false while signed in: this session ends with the process
};
type AuthError = {
  code: AuthErrorCode;
  message: string;
  retryAfterSeconds?: number;
};
type SignInResult =
  { ok: true; user: AuthUser } | { ok: false; error: AuthError };
```

### `@handijit/auth/main`

```ts
const createAuth: (options: AuthOptions) => Auth;
```

Throws a `TypeError` for a wrong option. Nothing else in this package throws or rejects for a
failure of the sign-in or the session: those are answers and states.

| Option            | Default                                            | Meaning                                                                                                 |
| ----------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `product`         | required                                           | The program's slug at the backend.                                                                      |
| `apiBaseUrl`      | `https://api.handijit.com`                         | Where the API lives.                                                                                    |
| `panelBaseUrl`    | `https://www.handijit.com`                         | Where the consent page lives. `https://` only; `http://` is accepted for a loopback host (development). |
| `userAgent`       | `<product>/<app version> (<OS> <version>; <arch>)` | Sent with every request. The backend stores it as the session's device name.                            |
| `signInTimeoutMs` | `600000`                                           | How long a sign-in waits for the browser.                                                               |
| `onCallback`      | none                                               | Called when the browser has come back. `attach` already brings the window to the front.                 |
| `openBrowser`     | `shell.openExternal`                               | Opens the consent page.                                                                                 |
| `fetch`           | Electron's `net.fetch`                             | The `fetch` requests are sent with (system proxy and certificate store).                                |
| `secretStore`     | `createSecretStore()` of `@handijit/electron`      | Where the session is kept, under the name `auth-session`.                                               |
| `port`            | a free port picked by the operating system         | A fixed loopback port, 1024–65535. A port in use fails the sign-in with `LISTENER_FAILED`.              |
| `logger`          | silent                                             | `{ info, warn }`; the logger of `@handijit/electron` fits. Never receives a token, a code or a `state`. |

| Member of `Auth`                   | What it does                                                                                                                                                                                                                    |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `client: AuthClient`               | The API client of `@handijit/core` bound to the session: it sends the access token, renews the session and repeats the request once. `exchangeDesktopCode`, `refresh` and `logout` are left out, of the type and of the object. |
| `handlers: Handlers<AuthContract>` | The handlers of the fragment, to spread into the app's handlers.                                                                                                                                                                |
| `getState(): AuthState`            | The current state.                                                                                                                                                                                                              |
| `onChange(listener): Unsubscribe`  | Calls the listener after every change.                                                                                                                                                                                          |
| `restore(): Promise<AuthState>`    | Reads the stored session, once. Never rejects.                                                                                                                                                                                  |
| `signIn(): Promise<SignInResult>`  | Signs in with the browser. A second call while one is waiting reopens the same address and resolves with the same result. Never rejects.                                                                                        |
| `cancelSignIn(): void`             | Ends a waiting sign-in with `SIGN_IN_CANCELLED`.                                                                                                                                                                                |
| `signOut(): Promise<void>`         | Wipes the session here, then tells the backend (best effort, at most five seconds). Never rejects.                                                                                                                              |
| `attach(host): Unsubscribe`        | Wires the session to the `AppContext` of `startApp`: broadcasts `auth:changed`, focuses the window on the callback, starts `restore`.                                                                                           |
| `dispose(): Promise<void>`         | Cancels a waiting sign-in and closes the listener. For a shutdown and for tests.                                                                                                                                                |

Another main-process package takes `auth.client` for its requests, and `auth.onChange` to drop
what it holds for the previous customer:

```ts
const devices = await auth.client.request({
  method: "GET",
  path: "/api/customer/devices",
  auth: true, // send the access token, renew the session once on a 401
  schema: z.array(deviceSchema),
});
auth.onChange((state) => {
  if (state.status !== "signed-in") cache.clear();
});
```

A request made while nobody is signed in is sent without a token and fails with the `401` of
`@handijit/core` (`isUnauthorized`); it does not change the state.

### `@handijit/auth/preload`

`AUTH_CHANNELS`, and nothing else.

### `@handijit/auth/renderer`

```ts
const getAuthStore: () => AuthStore;

type AuthStore = {
  getState: () => AuthState; // the same object until the state changes
  subscribe: (listener: () => void) => Unsubscribe;
  signIn: () => Promise<SignInResult>;
  cancelSignIn: () => Promise<void>;
  signOut: () => Promise<void>;
};
```

One store per page, shared by every copy of this package in the bundle. It connects to main on
the first subscription or action: it listens to `auth:changed` first and asks for the state
second. The actions never reject: an IPC failure becomes the `UNEXPECTED` error. The one thing
that throws is a missing bridge (`exposeBridge` was not called, or without the auth channels),
because that is a mistake in the program, not a failure of the sign-in.

`authErrorMessage` is exported here too.

### `@handijit/auth/react`

```ts
const useAuth: () => AuthState & {
  signIn: () => Promise<SignInResult>;
  cancelSignIn: () => Promise<void>;
  signOut: () => Promise<void>;
};
```

Built on `useSyncExternalStore`. The first render is `loading`, never a `signed-out` that flips
a moment later. The returned object keeps its identity until the state changes, and the three
actions keep theirs for the life of the page. Under React 19 StrictMode, several components
with the hook ask main for the state once and hold one subscription.

## Failures

`signIn()` resolves with `{ ok: false, error }`; the same error is in `state.error` until the
next sign-in or sign-out, except for a cancel, which is the customer's own choice and is not
kept. Every `message` is a Turkish sentence a screen can show as it is.

| Code                 | When                                                                                                                | State afterwards       |
| -------------------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| `SIGN_IN_TIMED_OUT`  | The browser did not come back within `signInTimeoutMs`.                                                             | `signed-out`           |
| `SIGN_IN_CANCELLED`  | `cancelSignIn()`, `signOut()` or `dispose()` during a sign-in.                                                      | `signed-out`, no error |
| `STATE_MISMATCH`     | The listener refused 20 requests (wrong or missing `state`, other paths, other hosts) and gave up.                  | `signed-out`           |
| `CODE_REFUSED`       | The backend refused the code (`DESKTOP_CODE_INVALID`): expired after 60 seconds, used, or not for this program run. | `signed-out`           |
| `RATE_LIMITED`       | `429` on the exchange. `retryAfterSeconds` carries the backend's `Retry-After`.                                     | `signed-out`           |
| `OFFLINE`            | The exchange got no answer (no network, timeout).                                                                   | `signed-out`           |
| `SESSION_ENDED`      | The backend refused the refresh token with `401`: signed out elsewhere, expired, or rotated by another holder.      | `signed-out`           |
| `NOT_A_CUSTOMER`     | The backend answered with an account that is not a customer's.                                                      | `signed-out`           |
| `BROWSER_NOT_OPENED` | `openBrowser` failed.                                                                                               | `signed-out`           |
| `LISTENER_FAILED`    | The loopback listener could not start (a fixed `port` in use, no loopback interface).                               | `signed-out`           |
| `UNEXPECTED`         | Anything else: an answer the API contract does not allow, a `5xx`, an IPC failure in the page.                      | `signed-out`           |

What does **not** end a session: no network at start-up, a timeout, a `5xx` or an unreadable
answer on a refresh. The customer stays `signed-in` with the stored name, and the request that
needed the token fails with the error of `@handijit/core`. Only a `401` on the refresh signs
them out.

## Security model

- **The listener** binds `127.0.0.1` explicitly, never `localhost` or `0.0.0.0`. It answers
  `GET /callback` and, after a valid callback, `GET /tamamlandi`; every other path or method is
  `404`, and a request whose `Host` is not `127.0.0.1:<port>` is `400` (DNS rebinding). It
  holds at most 32 connections, 8 kB of headers and five seconds per request.
- **`state`** is compared in constant time. A wrong or missing one is answered `400` and does
  not end the attempt, so a page that guesses the port cannot cancel a sign-in; after 20
  refused requests the attempt ends with `STATE_MISMATCH`. The first valid callback wins; the
  same callback again gets the same redirect and changes nothing.
- **PKCE (S256).** The verifier never leaves the process, so a code read from the loopback
  request is useless to anyone else. The code is exchanged once: the backend consumes it on
  the first attempt whatever the outcome.
- **The return page** has no script, no external resource and no link. It is served from an
  address without the code, with `Content-Security-Policy: default-src 'none'` plus the hash
  of its one style sheet, `base-uri`, `form-action` and `frame-ancestors 'none'`,
  `Cache-Control: no-store`, `Referrer-Policy: no-referrer` and
  `X-Content-Type-Options: nosniff`.
- **Storage.** The refresh token and a small snapshot of the user (id, e-mail, name) are
  written through the secret store of `@handijit/electron`, which encrypts with the operating
  system (`safeStorage`: Keychain, DPAPI, libsecret). The access token is kept in memory only.
  When the operating system offers no encryption, nothing is written: the session lives in
  memory until the program closes, `isRemembered` is `false`, and the logger gets a warning.
  Plain text is never used as a fallback.
- **Rotation.** The backend rotates the refresh token on every use with no grace period.
  Refreshes are single-flight, and both new tokens are in memory and on the disk before any
  request continues. A sign-out during a refresh or an exchange revokes the session that
  arrives afterwards.
- **The renderer** receives the state and nothing else. Neither the state nor any schema of
  the contract has a field for a token, and the page's store checks what arrives before it
  believes it.

Two limits that follow from the backend's contract and cannot be fixed here: a refresh whose
answer is lost on the way (the process is killed, the network drops after the request arrived)
loses the session, and the customer signs in again; and two processes that hold the same
session end it for both, so a program must keep the single-instance lock of `@handijit/electron`.

## What the program does itself

- **The sign-in screen**: a button for `signIn`, a way to cancel while `signing-in`, and the
  place where `error.message` is shown. Nothing here renders.
- **Naming the device.** The default `User-Agent` uses `app.getVersion()`; the panel's session
  list shows what the backend stored.
- **Reacting to the end of a session.** Listen to `auth.onChange` in main (or to `status` in
  the page) to drop what was loaded for the previous customer.
- **`isRemembered: false`.** Tell the customer, if the program wants to, that this machine
  cannot keep them signed in.
- **Deep links are not used.** The return is a loopback request, so no protocol registration
  is needed for the sign-in.
- **Development against a local panel**: pass `panelBaseUrl` and `apiBaseUrl`; nothing else
  changes.

## Sizes

Measured on the build of 1.0.0, which is not minified and keeps its comments; a program's
minified bundle carries less.

| Entry                     | Raw      | Gzip     |
| ------------------------- | -------- | -------- |
| `@handijit/auth`          | 5.27 kB  | 2.19 kB  |
| `@handijit/auth/main`     | 35.59 kB | 11.40 kB |
| `@handijit/auth/preload`  | 0.52 kB  | 0.31 kB  |
| `@handijit/auth/renderer` | 8.55 kB  | 3.26 kB  |
| `@handijit/auth/react`    | 9.19 kB  | 3.48 kB  |

`npm run size` prints the table and fails the build above the budgets in
`scripts/report-size.mjs`.

## Development

```sh
npm run verify          # lint, type-check, unit tests with 100% coverage, build, size, publint + attw
npm run test:electron   # launches the built package in a real Electron (needs `npm run build`)
sh scripts/smoke-test.sh  # installs the packed tarball into an empty project and uses it
```

The unit tests mock `electron` and nothing of this package: the loopback listener is a real
HTTP server that the tests call over the network, and the backend is a stand-in HTTP server
that follows the real one's rules (single-use codes that are consumed by a failed attempt,
rotation without a grace period, `429` with `Retry-After`, an empty `401` for a dead access
token).

`test:electron` is the proof that the real Electron behaves the way the mocks assume. It
starts a fixture app three times on one user-data folder (a sign-in on the ES module build, a
restart without a network on the CommonJS build, a restart after the session was ended
elsewhere) with main, preload and a React page wired as in the quick start, while the script
plays the backend and the browser. It checks the statuses the page renders, `safeStorage` on
the disk, `net.fetch` carrying the `User-Agent` and the access token, the rotation, and the
sign-out.

CI runs it on `macos-latest` and `windows-latest`; a release needs both.

## License

MIT
