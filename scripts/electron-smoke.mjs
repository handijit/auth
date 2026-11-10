import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import commonjs from "@rollup/plugin-commonjs";
import { nodeResolve } from "@rollup/plugin-node-resolve";
import replace from "@rollup/plugin-replace";
import { rollup } from "rollup";

// The backend of this test is the one the unit tests use. Node runs the TypeScript file as it
// is (type stripping), so there is one stand-in to keep faithful, not two.
import startFakeApi from "../__tests__/support/fake-api.ts";

// Launches a real Electron with the fixture app in e2e/app and the built package, three times
// on the same user-data folder: a sign-in (ES module build), a restart without a network
// (CommonJS build), and a restart after the session was ended elsewhere, with a new sign-in
// and a sign-out (ES module build). This script is the backend and the browser: the app hands
// it the address it would open, and it answers the way the consent page and Chrome do.
// The unit tests mock `electron`; this is the proof that the real one behaves as they assume.

const require = createRequire(import.meta.url);
const ROOT = resolve(import.meta.dirname, "..");
const APP = join(ROOT, "e2e/app");
const OUT = join(ROOT, "e2e/out");
const TIMEOUT_MS = 120_000;
const CUSTOMER = {
  id: 41,
  email: "ayse@example.com",
  name: "Ayşe Yılmaz",
  role: "CUSTOMER",
};
const EXCHANGE_PATH = "/api/public/desktop/token";
const REFRESH_PATH = "/api/auth/refresh";
const LOGOUT_PATH = "/api/auth/logout";
// `<product>/<version> (<OS> <version>; <arch>)`, the default of the package.
const USER_AGENT = /^notlar\/\S+ \((macOS|Windows|Linux) [^;]+; [a-z0-9_]+\)$/;

if (!existsSync(join(ROOT, "build/main.mjs"))) {
  console.error('electron-smoke: build/ is missing; run "npm run build" first');
  process.exit(1);
}

// `require("electron")` in Node is the path of the binary. It throws when the binary was not
// downloaded, which is the case after `npm ci --ignore-scripts`.
let electronBinary;
try {
  electronBinary = require("electron");
} catch {
  console.error(
    'electron-smoke: the Electron binary is missing; run "node node_modules/electron/install.js" first'
  );
  process.exit(1);
}

// The fixture's preload and renderer are bundled the way an app bundles them: the preload
// into one CommonJS file (a sandboxed preload cannot load a second file), the page as a module
// with React in it.
const bundle = async (input, output, plugins = []) => {
  const build = await rollup({
    input,
    external: ["electron"],
    plugins: [nodeResolve({ browser: true }), ...plugins],
  });
  await build.write(output);
  await build.close();
};

rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, "renderer/assets"), { recursive: true });
await bundle(join(APP, "preload.mjs"), {
  file: join(OUT, "preload.cjs"),
  format: "cjs",
});
await bundle(
  join(APP, "renderer.mjs"),
  { file: join(OUT, "renderer/assets/renderer.js"), format: "es" },
  [
    replace({
      preventAssignment: true,
      values: { "process.env.NODE_ENV": JSON.stringify("production") },
    }),
    commonjs(),
  ]
);
writeFileSync(
  join(OUT, "renderer/index.html"),
  readFileSync(join(APP, "index.html"), "utf8")
);

// What an app's bundles may import, measured on the fixture's own output.
const preloadSource = readFileSync(join(OUT, "preload.cjs"), "utf8");
const rendererSource = readFileSync(
  join(OUT, "renderer/assets/renderer.js"),
  "utf8"
);
const preloadImports = [
  ...preloadSource.matchAll(/require\(['"]([^'"]+)['"]\)/g),
].map(([, name]) => name);
const bundleChecks = [
  {
    name: "the bundled preload requires electron and nothing else",
    ok: preloadImports.every((name) => name === "electron"),
    detail: preloadImports,
  },
  {
    name: "the bundled preload carries no Zod",
    ok: !/ZodType|safeParse/.test(preloadSource),
  },
  {
    name: "the bundled page has no import left",
    ok: !/^\s*import\s/m.test(rendererSource),
  },
  {
    name: "the bundled page carries no Zod and no Node",
    ok: !/ZodType|safeParse|["'`]node:/.test(rendererSource),
  },
];

const api = await startFakeApi();

// What the "browser" saw, as checks of the launch it happened in.
let browserChecks = [];
const browserCheck = (name, ok, detail) => {
  browserChecks.push({ name, ok: ok === true, detail });
};
const isRefused = (url) =>
  fetch(url).then(
    () => false,
    () => true
  );

// The consent page and Chrome, for one address the program asked to open.
const playBrowser = async (address) => {
  const url = new URL(address);
  const redirectUri = url.searchParams.get("redirect_uri") ?? "";
  const state = url.searchParams.get("state") ?? "";
  const codeChallenge = url.searchParams.get("code_challenge") ?? "";
  browserCheck(
    "browser: the program opens the consent page on the www host",
    url.origin + url.pathname ===
      "https://www.handijit.com/panel/masaustu-giris",
    address
  );
  browserCheck(
    "browser: the address carries the product, an S256 challenge, a loopback redirect and a state",
    url.searchParams.get("product") === "notlar" &&
      /^[A-Za-z0-9_-]{43}$/.test(codeChallenge) &&
      /^http:\/\/127\.0\.0\.1:\d{4,5}\/callback$/.test(redirectUri) &&
      /^[A-Za-z0-9_-]{22,200}$/.test(state) &&
      [...url.searchParams.keys()].length === 4,
    address
  );

  // What a page on the machine could try before the customer has approved anything.
  const forged = await fetch(`${redirectUri}?code=forged&state=guessed`);
  browserCheck(
    "browser: a callback with another state is refused",
    forged.status === 400,
    forged.status
  );
  const favicon = await fetch(new URL("/favicon.ico", redirectUri));
  browserCheck(
    "browser: the favicon request of a real browser gets a 404",
    favicon.status === 404,
    favicon.status
  );
  const localhost = await fetch(
    `${redirectUri.replace("127.0.0.1", "localhost")}?code=x&state=${state}`
  ).then(
    (response) => response.status,
    () => "refused"
  );
  browserCheck(
    "browser: the listener does not answer under another host name",
    localhost === 400 || localhost === "refused",
    localhost
  );

  // The customer approves: the consent page sends the browser back with a one-time code.
  const code = api.authorize({ user: CUSTOMER, codeChallenge, redirectUri });
  const callback = await fetch(
    `${redirectUri}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
    { redirect: "manual" }
  );
  browserCheck(
    "browser: the callback is answered with a redirect to an address without the code",
    callback.status === 303 &&
      callback.headers.get("location") === "/tamamlandi",
    [callback.status, callback.headers.get("location")]
  );
  const done = await fetch(new URL("/tamamlandi", redirectUri));
  const html = await done.text();
  browserCheck(
    "browser: the return page is the Turkish one",
    done.status === 200 &&
      html.includes("Programa dönebilirsiniz") &&
      html.includes('lang="tr"'),
    done.status
  );
  browserCheck(
    "browser: the return page loads nothing, runs nothing and is not kept",
    (done.headers.get("content-security-policy") ?? "").startsWith(
      "default-src 'none'"
    ) &&
      done.headers.get("cache-control") === "no-store" &&
      done.headers.get("referrer-policy") === "no-referrer" &&
      !/<script|<link|<img|https?:/.test(html),
    Object.fromEntries(done.headers)
  );
  let isClosed = false;
  for (let attempt = 0; attempt < 100 && !isClosed; attempt += 1) {
    isClosed = await isRefused(new URL("/tamamlandi", redirectUri));
  }
  browserCheck(
    "browser: the listener is gone once the page was served",
    isClosed
  );
};

// The app talks to this server: it hands over the address it would open, asks for the network
// back and reads what the backend counted. No token ever goes this way.
let pendingBrowser = Promise.resolve();
const controlServer = createServer((request, response) => {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    const path = new URL(request.url, "http://localhost").pathname;
    if (path === "/browser") {
      const { url, action } = JSON.parse(Buffer.concat(chunks).toString());
      // Answered at once, as an opener is; the browser does its part afterwards.
      response.writeHead(204).end();
      if (action === "approve") {
        pendingBrowser = playBrowser(url).catch((error) => {
          browserCheck(
            "browser: the visit ran to its end",
            false,
            String(error)
          );
        });
      }
      return;
    }
    if (path === "/online") {
      api.setOffline(false);
      response.writeHead(204).end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        requests: api.requests.length,
        exchanges: api.countOf(EXCHANGE_PATH),
        refreshes: api.countOf(REFRESH_PATH),
        logouts: api.countOf(LOGOUT_PATH),
        activeSessions: api.sessions.filter((session) => !session.isRevoked)
          .length,
      })
    );
  });
});
await new Promise((done) => controlServer.listen(0, "127.0.0.1", done));
const controlUrl = `http://127.0.0.1:${controlServer.address().port}`;

const directory = mkdtempSync(join(tmpdir(), "handijit-auth-smoke-"));
const secretFile = join(directory, "user-data/secrets/auth-session.bin");
const storedBytes = () =>
  existsSync(secretFile) ? readFileSync(secretFile, "latin1") : null;

const launch = async ({ name, entry, phase, after }) => {
  browserChecks = [];
  const resultFile = join(directory, "result.json");
  rmSync(resultFile, { force: true });

  const environment = {
    ...process.env,
    SMOKE_DIR: directory,
    SMOKE_OUT: OUT,
    SMOKE_PHASE: phase,
    SMOKE_API_URL: api.url,
    SMOKE_CONTROL_URL: controlUrl,
    ELECTRON_ENABLE_LOGGING: "1",
  };
  delete environment.ELECTRON_RUN_AS_NODE;
  delete environment.ELECTRON_RENDERER_URL;

  const child = spawn(electronBinary, [join(APP, entry)], {
    cwd: ROOT,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));

  const exit = await new Promise((done) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done({ code: null, timedOut: true });
    }, TIMEOUT_MS);
    child.once("exit", (code) => {
      clearTimeout(timer);
      done({ code, timedOut: false });
    });
  });
  await pendingBrowser;

  const result = existsSync(resultFile)
    ? JSON.parse(readFileSync(resultFile, "utf8"))
    : { checks: [] };
  const checks = [...result.checks, ...browserChecks, ...after()];
  checks.push({
    name: "the app wrote its result and quit normally",
    ok: existsSync(resultFile) && exit.code === 0,
    detail: exit.timedOut
      ? `killed after ${TIMEOUT_MS} ms`
      : `exit code ${exit.code}`,
  });

  const failed = checks.filter(({ ok }) => !ok);
  for (const { name: label, ok, detail } of checks) {
    console.log(`${ok ? "ok  " : "FAIL"} [${name}] ${label}`);
    if (!ok) console.log(`       ${JSON.stringify(detail)}`);
  }
  if (failed.length > 0) console.log(`--- output of [${name}] ---\n${output}`);
  return { ...result, total: checks.length, failed: failed.length };
};

// What only the backend and the disk can tell, read after each launch.
const requestsTo = (path) =>
  api.requests.filter((request) => request.path === path);
const isSecretOpaque = () => {
  const bytes = storedBytes();
  return (
    bytes !== null &&
    !bytes.includes(CUSTOMER.email) &&
    !bytes.includes("refreshToken") &&
    api.sessions.every(
      (session) =>
        !bytes.includes(session.refreshToken) &&
        !bytes.includes(session.accessToken)
    )
  );
};

const runs = [];
try {
  runs.push(
    await launch({
      name: "sign-in, esm",
      entry: "main.mjs",
      phase: "sign-in",
      after: () => [
        {
          name: "backend: the exchange carries the program's User-Agent through net.fetch",
          ok: USER_AGENT.test(requestsTo(EXCHANGE_PATH)[0]?.userAgent ?? ""),
          detail: requestsTo(EXCHANGE_PATH)[0]?.userAgent,
        },
        {
          name: "backend: the code was exchanged once, with the redirect address it was issued for",
          ok:
            requestsTo(EXCHANGE_PATH).length === 1 &&
            api.sessions.length === 1 &&
            !api.sessions[0].isRevoked,
          detail: requestsTo(EXCHANGE_PATH).length,
        },
        {
          name: "disk: the stored session is encrypted by the operating system",
          ok: isSecretOpaque(),
        },
      ],
    })
  );

  api.setOffline(true);
  runs.push(
    await launch({
      name: "offline restart, cjs",
      entry: "main.cjs",
      phase: "offline",
      after: () => [
        {
          name: "backend: the refresh rotated the session, and only one is alive",
          ok:
            api.sessions.length === 2 &&
            api.sessions[0].isRevoked &&
            !api.sessions[1].isRevoked,
          detail: api.sessions.map((session) => session.isRevoked),
        },
        {
          name: "backend: the refresh carries the same User-Agent as the exchange",
          ok:
            requestsTo(REFRESH_PATH).at(-1)?.userAgent ===
            requestsTo(EXCHANGE_PATH)[0]?.userAgent,
          detail: requestsTo(REFRESH_PATH).at(-1)?.userAgent,
        },
        {
          name: "disk: the renewed session is encrypted by the operating system",
          ok: isSecretOpaque(),
        },
      ],
    })
  );

  api.revokeAll();
  runs.push(
    await launch({
      name: "ended elsewhere, sign-in, sign-out, esm",
      entry: "main.mjs",
      phase: "ended",
      after: () => [
        {
          name: "backend: the sign-out named the session of the new sign-in",
          ok:
            requestsTo(LOGOUT_PATH).length === 1 &&
            requestsTo(LOGOUT_PATH)[0].body?.refreshToken ===
              api.sessions.at(-1)?.refreshToken,
          detail: requestsTo(LOGOUT_PATH).length,
        },
        {
          name: "backend: no session is left alive",
          ok: api.sessions.every((session) => session.isRevoked),
          detail: api.sessions.map((session) => session.isRevoked),
        },
        {
          name: "disk: nothing is stored after the sign-out",
          ok: storedBytes() === null,
        },
      ],
    })
  );
} finally {
  controlServer.close();
  await api.close();
  rmSync(directory, { recursive: true, force: true });
}

for (const { name, ok, detail } of bundleChecks) {
  console.log(`${ok ? "ok  " : "FAIL"} [bundle] ${name}`);
  if (!ok) console.log(`       ${JSON.stringify(detail)}`);
}
const total =
  runs.reduce((sum, run) => sum + run.total, 0) + bundleChecks.length;
const failed =
  runs.reduce((sum, run) => sum + run.failed, 0) +
  bundleChecks.filter(({ ok }) => !ok).length;
const [{ electron, chrome, node, platform }] = runs;

if (failed > 0) {
  console.error(`electron-smoke: ${failed} of ${total} checks FAILED`);
  process.exit(1);
}
console.log(
  `electron-smoke: ${total} checks passed in ${runs.length} launches on Electron ${electron} (Chromium ${chrome}, Node ${node}, ${platform})`
);
