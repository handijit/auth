import * as shared from "@handijit/auth";
import * as main from "@handijit/auth/main";
import { CORE_CHANNELS, channelsOf, defineContract } from "@handijit/electron";
import { startApp } from "@handijit/electron/main";
import { z } from "zod";

import channels from "./channels.mjs";
import run from "./scenario.cjs";

// The ES module build of the package, resolved through its "exports" map.
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
