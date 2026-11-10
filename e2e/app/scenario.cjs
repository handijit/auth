"use strict";

// The main-process half of the real-Electron smoke test. It starts the fixture app with the
// built package, drives the page and writes one JSON file with every check it made.
// scripts/electron-smoke.mjs spawns it, plays the backend and the browser, and reads that file.

const {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} = require("node:fs");
const { join } = require("node:path");
const { isDeepStrictEqual } = require("node:util");

const { app } = require("electron");

const DIRECTORY = process.env.SMOKE_DIR;
const OUT = process.env.SMOKE_OUT;
const PHASE = process.env.SMOKE_PHASE;
const API_URL = process.env.SMOKE_API_URL;
const CONTROL_URL = process.env.SMOKE_CONTROL_URL;

const USER = { id: 41, email: "ayse@example.com", name: "Ayşe Yılmaz" };
const SIGNED_OUT = {
  status: "signed-out",
  user: null,
  error: null,
  isRemembered: false,
};
const SIGNED_IN = {
  status: "signed-in",
  user: USER,
  error: null,
  isRemembered: true,
};

const checks = [];
const check = (name, ok, detail) => {
  checks.push({
    name,
    ok: ok === true,
    detail: ok === true ? undefined : detail,
  });
};
const same = (name, actual, expected) =>
  check(name, isDeepStrictEqual(actual, expected), actual);

const within = (promise, label, milliseconds = 15_000) =>
  Promise.race([
    promise,
    new Promise((_resolve, reject) => {
      setTimeout(
        () => reject(new Error(`timed out waiting for ${label}`)),
        milliseconds
      ).unref();
    }),
  ]);
const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));
const until = async (predicate, label) => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await predicate()) return true;
    await sleep(50);
  }
  check(label, false, "the condition never became true");
  return false;
};

// The runner: it is the backend and the browser of this test.
const control = async (path, body) => {
  const response = await fetch(`${CONTROL_URL}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return response.status === 204 ? undefined : response.json();
};
const isRefused = (url) =>
  fetch(url).then(
    () => false,
    () => true
  );

const scenario = async ({
  shared,
  main,
  defineContract,
  channelsOf,
  startApp,
  z,
  channels,
  coreChannels,
}) => {
  const contract = defineContract({
    invoke: {
      ...shared.authContract.invoke,
      "app:info": { output: z.object({ electron: z.string() }) },
    },
    events: { ...shared.authContract.events },
  });
  same(
    "contract: the Zod-free channel list of the preload equals the composed contract",
    channelsOf(contract),
    channels
  );

  // What the "browser" does with the address: nothing (the customer looks at the page) or
  // approve. The address goes to the runner instead of the system browser.
  let browserAction = "ignore";
  const opened = [];
  let callbacks = 0;
  const logged = [];
  const auth = main.createAuth({
    product: "notlar",
    apiBaseUrl: API_URL,
    openBrowser: async (url) => {
      opened.push(url);
      await control("/browser", { url, action: browserAction });
    },
    onCallback: () => {
      callbacks += 1;
    },
    logger: {
      info: (message, details) => logged.push({ message, details }),
      warn: (message, details) => logged.push({ message, details }),
    },
  });
  same("main: a new session is loading and has done nothing", auth.getState(), {
    ...SIGNED_OUT,
    status: "loading",
  });
  check(
    "main: the client does not carry the calls that move the session",
    !("refresh" in auth.client) &&
      !("logout" in auth.client) &&
      !("exchangeDesktopCode" in auth.client) &&
      typeof auth.client.request === "function"
  );

  let stateCalls = 0;
  const context = await startApp({
    contract,
    handlers: () => ({
      ...auth.handlers,
      "auth:get-state": (input, event) => {
        stateCalls += 1;
        return auth.handlers["auth:get-state"](input, event);
      },
      "app:info": () => ({ electron: process.versions.electron }),
    }),
    rendererRoot: join(OUT, "renderer"),
    window: { preload: join(OUT, "preload.cjs"), width: 640, height: 480 },
    log: { level: "debug", mirrorToConsole: false },
    beforeWindow: (appContext) => {
      auth.attach(appContext);
    },
  });

  const window = context.getWindow();
  const page = window.webContents;
  const evaluate = (code) =>
    within(page.executeJavaScript(code, true), `page: ${code.slice(0, 60)}`);
  if (page.isLoading()) {
    await within(
      new Promise((resolve) => page.once("did-finish-load", resolve)),
      "the first page load"
    );
  }
  const statusOnPage = () =>
    evaluate(`document.querySelector("#screen")?.dataset.status ?? null`);
  const waitForStatus = (status) =>
    until(
      async () => (await statusOnPage()) === status,
      `page: the screen shows ${status}`
    );
  const textOf = (id) =>
    evaluate(`document.querySelector("#${id}")?.textContent ?? null`);
  const click = (id) => evaluate(`document.querySelector("#${id}").click()`);
  const statuses = () => evaluate("window.__smoke.statuses");
  const secretFile = join(app.getPath("userData"), "secrets/auth-session.bin");

  const signInThroughTheBrowser = async () => {
    const before = opened.length;
    browserAction = "approve";
    await click("sign-in");
    await waitForStatus("signed-in");
    return new URL(opened[before]);
  };

  if (PHASE === "sign-in") {
    // 1. A machine that never signed in.
    await waitForStatus("signed-out");
    same(
      "start: the screen renders loading, then signed-out, nothing else",
      await statuses(),
      ["loading", "signed-out"]
    );
    same("start: main reports signed-out", auth.getState(), SIGNED_OUT);
    same(
      "start: two components with the hook and a StrictMode double mount ask main once",
      stateCalls,
      1
    );
    // `exposeBridge` adds the channels @handijit/electron owns to the ones it is given.
    same(
      "page: the bridge exposes the program's channels, the core ones and nothing else",
      await evaluate("window.__smoke.bridge()"),
      {
        keys: ["invoke", "on"],
        invoke: [
          ...Object.keys(channels.invoke),
          ...Object.keys(coreChannels.invoke),
        ].sort(),
        on: [
          ...Object.keys(channels.events),
          ...Object.keys(coreChannels.events),
        ].sort(),
      }
    );
    same(
      "page: no Node in the page",
      await evaluate("window.__smoke.hasNode"),
      false
    );
    check("start: nothing is stored", !existsSync(secretFile));
    same(
      "start: the backend was not called",
      (await control("/stats")).requests,
      0
    );

    // 2. A sign-in the customer cancels.
    await click("sign-in");
    await waitForStatus("signing-in");
    await until(() => opened.length === 1, "cancel: the browser is opened");
    const first = new URL(opened[0]);
    const firstRedirect = first.searchParams.get("redirect_uri");
    same(
      "cancel: the listener is up and answers anything but the callback with 404",
      (await fetch(new URL("/favicon.ico", firstRedirect))).status,
      404
    );
    await click("sign-in");
    await until(() => opened.length === 2, "cancel: the second click reopens");
    same(
      "cancel: a second click reopens the same address",
      opened[1],
      opened[0]
    );
    await click("cancel");
    await waitForStatus("signed-out");
    await until(
      async () => (await evaluate("window.__smoke.results.length")) === 2,
      "cancel: both clicks got their answer"
    );
    same(
      "cancel: the page's signIn resolves with SIGN_IN_CANCELLED",
      await evaluate(
        "window.__smoke.results.map((result) => result.error?.code)"
      ),
      ["SIGN_IN_CANCELLED", "SIGN_IN_CANCELLED"]
    );
    same(
      "cancel: no error is shown for the customer's own choice",
      await textOf("error"),
      ""
    );
    check(
      "cancel: the loopback port is closed",
      await isRefused(new URL("/favicon.ico", firstRedirect))
    );
    same(
      "cancel: the backend was not called",
      (await control("/stats")).requests,
      0
    );

    // 3. A sign-in that goes through: the runner plays the browser.
    const second = await signInThroughTheBrowser();
    same(
      "sign-in: the screen shows the customer",
      await textOf("name"),
      USER.name
    );
    same(
      "sign-in: every component sees it",
      await textOf("badge"),
      "signed-in"
    );
    same(
      "sign-in: the screen went through exactly these statuses",
      await statuses(),
      [
        "loading",
        "signed-out",
        "signing-in",
        "signed-out",
        "signing-in",
        "signed-in",
      ]
    );
    same(
      "sign-in: the page's signIn resolves with the user",
      await evaluate("window.__smoke.results.at(-1)"),
      { ok: true, user: USER }
    );
    same(
      "sign-in: main reports the session as remembered",
      auth.getState(),
      SIGNED_IN
    );
    same(
      "sign-in: the store of the renderer entry is the store of the React entry",
      await evaluate("window.__smoke.storeState()"),
      SIGNED_IN
    );
    same("sign-in: the callback hook ran once", callbacks, 1);
    check("sign-in: the window is showing", window.isVisible());
    check(
      "sign-in: a new attempt has a new state, challenge and port",
      second.searchParams.get("state") !== first.searchParams.get("state") &&
        second.searchParams.get("code_challenge") !==
          first.searchParams.get("code_challenge")
    );
    check("sign-in: the session is stored", existsSync(secretFile));
    const me = await auth.client.getCurrentUser();
    same(
      "sign-in: the client sends the access token through net.fetch",
      me.email,
      USER.email
    );
    const stats = await control("/stats");
    same(
      "sign-in: one exchange, no refresh",
      [stats.exchanges, stats.refreshes],
      [1, 0]
    );
    same(
      "sign-in: the page still asked main for the state once",
      stateCalls,
      1
    );
  }

  if (PHASE === "offline") {
    // 4. A restart without a network: the customer stays signed in.
    await waitForStatus("signed-in");
    same(
      "offline start: the screen renders loading, then signed-in, never signed-out",
      await statuses(),
      ["loading", "signed-in"]
    );
    same(
      "offline start: the screen shows the customer from the stored snapshot",
      await textOf("name"),
      USER.name
    );
    await until(
      () =>
        logged.some(({ message }) =>
          message.startsWith("The stored session could not be checked")
        ),
      "offline start: the failed check is logged"
    );
    same("offline start: main stays signed in", auth.getState(), SIGNED_IN);
    const before = readFileSync(secretFile, "latin1");

    // 5. The network is back: the first request renews the session.
    await control("/online", {});
    const me = await auth.client.getCurrentUser();
    same(
      "back online: a request renews the session and goes through",
      me.email,
      USER.email
    );
    check(
      "back online: the rotated refresh token is on the disk",
      readFileSync(secretFile, "latin1") !== before
    );
    const stats = await control("/stats");
    same(
      "back online: one session is alive at the backend",
      stats.activeSessions,
      1
    );
    same("back online: the screen never left signed-in", await statuses(), [
      "loading",
      "signed-in",
    ]);
  }

  if (PHASE === "ended") {
    // 6. The session was ended in the panel while the program was closed.
    await waitForStatus("signed-out");
    await until(
      async () => (await textOf("code")) === "SESSION_ENDED",
      "ended: the screen shows why"
    );
    same(
      "ended: the screen shows the Turkish sentence",
      await textOf("error"),
      shared.authErrorMessage("SESSION_ENDED")
    );
    check(
      "ended: the screen never showed a sign-in in progress",
      !(await statuses()).includes("signing-in"),
      await statuses()
    );
    await until(
      () => !existsSync(secretFile),
      "ended: the stored session is wiped"
    );

    // 7. Sign in again, then sign out.
    await signInThroughTheBrowser();
    same("sign-in again: the error is gone", await textOf("error"), "");
    same("sign-in again: main is signed in", auth.getState(), SIGNED_IN);
    check("sign-in again: the session is stored", existsSync(secretFile));

    await click("sign-out");
    await waitForStatus("signed-out");
    same("sign-out: the screen shows no error", await textOf("error"), "");
    same("sign-out: main is signed out", auth.getState(), SIGNED_OUT);
    await until(
      () => !existsSync(secretFile),
      "sign-out: the stored session is wiped"
    );
    await until(
      async () => (await control("/stats")).logouts === 1,
      "sign-out: the backend is told"
    );
    same(
      "sign-out: no session is alive at the backend",
      (await control("/stats")).activeSessions,
      0
    );
    const refused = await auth.client.getCurrentUser().then(
      () => null,
      (error) => error.status
    );
    same("sign-out: the client has no token left", refused, 401);
  }

  check(
    "log: no line carries a token, a code or a state",
    logged.every(({ details }) =>
      Object.keys(details ?? {}).every((key) => key === "reason")
    ),
    logged
  );
  await auth.dispose();
};

const run = (dependencies) => {
  app.setName("handijit-auth-smoke");
  app.setPath("userData", join(DIRECTORY, "user-data"));
  mkdirSync(join(DIRECTORY, "logs"), { recursive: true });
  app.setAppLogsPath(join(DIRECTORY, "logs"));
  // The mock keychain keeps macOS from asking for the login keychain; safeStorage still runs.
  if (process.platform === "darwin")
    app.commandLine.appendSwitch("use-mock-keychain");

  scenario(dependencies)
    .catch((error) => {
      check("the scenario ran to its end", false, error.stack ?? String(error));
    })
    .then(() => {
      writeFileSync(
        join(DIRECTORY, "result.json"),
        JSON.stringify({
          electron: process.versions.electron,
          chrome: process.versions.chrome,
          node: process.versions.node,
          platform: `${process.platform}-${process.arch}`,
          checks,
        })
      );
      app.quit();
    });
};

module.exports = run;
