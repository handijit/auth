// The preload entry: the channel names and nothing else. It has no import at all, so a bundler
// inlines it into the single CommonJS file a sandboxed preload has to be.
import AUTH_CHANNELS from "./shared/auth-channels.constants";

export { AUTH_CHANNELS };
