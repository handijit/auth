const shared = require("@handijit/auth");
const preload = require("@handijit/auth/preload");
const renderer = require("@handijit/auth/renderer");

const fail = (message) => {
  throw new Error(`CJS entry is broken: ${message}`);
};

if (
  Object.keys(shared.authContract.invoke).join() !==
  Object.keys(preload.AUTH_CHANNELS.invoke).join()
) {
  fail("the channel list differs from the contract");
}
if (shared.signInResultSchema.safeParse({ ok: true }).success !== false)
  fail("signInResultSchema");
if (shared.AUTH_STATUSES.join() !== "loading,signed-out,signing-in,signed-in")
  fail("AUTH_STATUSES");
if (typeof renderer.getAuthStore !== "function") fail("renderer");
if (renderer.authErrorMessage("OFFLINE") !== shared.authErrorMessage("OFFLINE"))
  fail("authErrorMessage");
for (const [subpath, file] of [
  ["main", "main.cjs"],
  ["react", "react.cjs"],
]) {
  if (!require.resolve(`@handijit/auth/${subpath}`).endsWith(`/build/${file}`))
    fail(subpath);
}
require("@handijit/auth/package.json");

console.log("CJS entries OK");
