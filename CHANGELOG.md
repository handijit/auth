# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the package follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.1] - 2026-11-10

### Fixed

- The quick start no longer awaits `startApp` at the top level of an ES module main: Electron
  emits `ready` only after the main module has finished evaluating, so the program hung at
  start-up. It now calls `startApp(...).catch(...)`.

## [1.0.0] - 2026-11-10

First release: "Sign in with the browser" for Han Dijit's Electron desktop
programs and the session that results, in five entry points (`.`, `./main`,
`./preload`, `./renderer`, `./react`), as ES modules and CommonJS.

### Added

- `createAuth` (`./main`): the session of one installation. It signs in through
  the panel's consent page (RFC 8252 loopback redirect with PKCE S256), keeps the
  session, renews it and signs out; `restore`, `signIn`, `cancelSignIn`,
  `signOut`, `getState`, `onChange`, `attach` and `dispose`.
- `auth.client`: the API client of `@handijit/core` bound to the session, for
  the rest of the main process. It sends the access token and renews the session
  once on a `401`. `exchangeDesktopCode`, `refresh` and `logout` are left out of
  it, so nothing can move the session behind this package's back.
- The loopback listener: bound to `127.0.0.1` on a port the operating system
  picks, `GET /callback` only, `Host` check, `state` compared in constant time,
  the first valid callback wins, and a self-contained Turkish return page
  ("Programa dönebilirsiniz") for light and dark, served under a strict
  Content-Security-Policy with `no-store` and `no-referrer`.
- `authContract` and `AUTH_CHANNELS` (`.`): the IPC contract fragment
  (`auth:get-state`, `auth:sign-in`, `auth:cancel-sign-in`, `auth:sign-out`, and
  the event `auth:changed`) to spread into `defineContract`, with its Zod
  schemas; `AUTH_CHANNELS` (`./preload`) is the same list without Zod and without
  any import, for the preload.
- `getAuthStore` (`./renderer`): one store per page over `window.desktop`, with
  no framework and no Zod; everything it receives is checked before it is
  believed.
- `useAuth` (`./react`): the state (`loading`, `signed-out`, `signing-in`,
  `signed-in`), the user, the last error and the three actions, on
  `useSyncExternalStore`; safe under React 19 StrictMode, with no provider.
- Typed failures with a stable code and a Turkish sentence
  (`AUTH_ERROR_CODES`, `authErrorMessage`): `SIGN_IN_TIMED_OUT`,
  `SIGN_IN_CANCELLED`, `STATE_MISMATCH`, `CODE_REFUSED`, `RATE_LIMITED` (with
  `retryAfterSeconds`), `OFFLINE`, `SESSION_ENDED`, `NOT_A_CUSTOMER`,
  `BROWSER_NOT_OPENED`, `LISTENER_FAILED` and `UNEXPECTED`.

### Decisions

Where the backend's contract and the house documents were silent:

- **React has its own entry.** `./renderer` works without React; `./react` is the
  hook. `react` is an optional peer dependency.
- **The port is the operating system's choice** (`listen(0)`), which cannot
  collide; `port` fixes one for a program that needs it.
- **Every refused request counts toward one bound.** A request with a wrong or
  missing `state`, another path or another host does not end the attempt; after
  20 of them the attempt ends with `STATE_MISMATCH`.
- **The callback is answered with a `303` to `/tamamlandi`**, so the code does
  not stay in the address bar or the history. The listener closes once that page
  is served, or five seconds after the callback.
- **The return page promises nothing about the exchange.** It is served before
  the code is exchanged; a failure is shown in the program's window.
- **A sign-in waits ten minutes** by default (`signInTimeoutMs`): long enough to
  register and verify an e-mail address on the way.
- **A second `signIn()` while one is waiting** reopens the same address and
  resolves with the same result; there is never a second listener.
- **A cancel is an answer, not an error to show.** `signIn()` resolves with
  `SIGN_IN_CANCELLED`, and `state.error` stays `null`. A cancel that arrives
  while the code is being exchanged revokes the session that was issued.
- **The user snapshot lives inside the encrypted secret** with the refresh
  token (id, e-mail, name), so nothing about the account is on the disk in plain
  text. The access token is never written.
- **No encryption, no disk.** When the operating system offers no encryption,
  the session lives in memory until the program closes, `isRemembered` is
  `false` and the logger gets a warning. Plain text is never a fallback.
- **A restored session is shown at once** and checked with the backend in the
  background. No network, a timeout, a `5xx` or an unreadable answer keep the
  customer signed in; only a `401` on the refresh ends the session, with
  `SESSION_ENDED`.
- **An access token is treated as expired 30 seconds early** (half its life for
  a token shorter than a minute), so a request does not leave with one that
  dies on the way.
- **A sign-out wipes first and tells the backend second**, waiting at most five
  seconds. A refresh or an exchange that answers after a sign-out revokes what
  it was given.
- **The default `User-Agent`** is `<product>/<app version> (<OS> <version>;
<arch>)`, for example `notlar/1.4.0 (macOS 27.2.0; arm64)`: the backend stores
  it as the session's device name.
- **The consent page is opened with `shell.openExternal`** directly (option
  `openBrowser`), because the `openExternal` of `@handijit/electron` allows
  `https` hosts only and a development panel runs on `http://localhost`.
- **`attach` steals the focus on macOS** (`app.focus({ steal: true })`) after
  showing the window: the browser is the active application at that moment.
- **The store's actions never reject.** An IPC failure becomes the `UNEXPECTED`
  error. A missing bridge throws, because it is a mistake in the program.
- **The build is not minified** and keeps its comments, like
  `@handijit/electron`; the size budgets are measured on that output.

[Unreleased]: https://github.com/handijit/auth/compare/v1.0.1...HEAD
[1.0.1]: https://github.com/handijit/auth/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/handijit/auth/releases/tag/v1.0.0
