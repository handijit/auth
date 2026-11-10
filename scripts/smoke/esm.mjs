import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineContract, channelsOf } from "@handijit/electron";
import * as shared from "@handijit/auth";
import * as preload from "@handijit/auth/preload";
import * as renderer from "@handijit/auth/renderer";

const fail = (message) => {
  throw new Error(`ESM entry is broken: ${message}`);
};
const resolve = (specifier) => fileURLToPath(import.meta.resolve(specifier));

// The fragment composes into an app's contract, and the Zod-free channel list is the same list.
const contract = defineContract({
  invoke: { ...shared.authContract.invoke, "notes:list": {} },
  events: { ...shared.authContract.events },
});
const channels = channelsOf(contract);
for (const channel of Object.keys(preload.AUTH_CHANNELS.invoke)) {
  if (channels.invoke[channel] !== true) fail(`channel ${channel}`);
}
if (channels.events["auth:changed"] !== true) fail("event auth:changed");
if (
  shared.authStateSchema.safeParse({
    status: "signed-out",
    user: null,
    error: null,
    isRemembered: false,
  }).success !== true
) {
  fail("authStateSchema");
}
if (!shared.AUTH_ERROR_CODES.includes("SESSION_ENDED")) fail("error codes");
if (
  shared.authErrorMessage("RATE_LIMITED", 120) !==
  "Çok fazla deneme yapıldı. 2 dakika sonra yeniden deneyin."
) {
  fail("authErrorMessage");
}

// The renderer entry loads without a window and without React (an optional peer that this
// project did not install); it reaches for the bridge only when it is used.
const store = renderer.getAuthStore();
if (store.getState().status !== "loading") fail("the first state");
if (renderer.getAuthStore() !== store) fail("one store per page");
try {
  store.subscribe(() => undefined);
  fail("the store connected without a bridge");
} catch (error) {
  if (!String(error.message).includes("window.desktop is missing")) throw error;
}

// main imports `electron`, which only an Electron process can load, and the React entry
// imports `react`: here they only have to resolve to the right files. The Electron smoke test
// loads them for real.
for (const [subpath, file] of [
  ["main", "main.mjs"],
  ["react", "react.mjs"],
]) {
  const path = resolve(`@handijit/auth/${subpath}`);
  if (!path.endsWith(`/build/${file}`) || !existsSync(path)) fail(subpath);
}

console.log("ESM entries OK");
