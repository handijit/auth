"use strict";

const shared = require("@handijit/auth");
const main = require("@handijit/auth/main");
const {
  CORE_CHANNELS,
  channelsOf,
  defineContract,
} = require("@handijit/electron");
const { startApp } = require("@handijit/electron/main");
const { z } = require("zod");

const run = require("./scenario.cjs");

// The CommonJS build of the package, resolved through its "exports" map. The channel list is
// an ES module: it is written out again here, and the scenario compares it to the contract.
const channels = {
  invoke: { ...shared.AUTH_CHANNELS.invoke, "app:info": true },
  events: { ...shared.AUTH_CHANNELS.events },
};

run({
  shared,
  main,
  defineContract,
  channelsOf,
  startApp,
  z,
  channels,
  coreChannels: CORE_CHANNELS,
});
