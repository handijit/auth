import { AUTH_CHANNELS } from "@handijit/auth/preload";

// The fixture's channel names, without Zod: this package's fragment and one channel of the
// app's own, the way a program composes them. The scenario asserts that the list equals
// channelsOf(contract).
export default {
  invoke: { ...AUTH_CHANNELS.invoke, "app:info": true },
  events: { ...AUTH_CHANNELS.events },
};
