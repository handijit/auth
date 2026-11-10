import { z } from "zod";

import AUTH_ERROR_CODES from "./auth-error-codes.constants";
import AUTH_STATUSES from "./auth-statuses.constants";

/** Who is signed in: what a screen needs, and nothing a token could be derived from. */
const authUserSchema = z.object({
  id: z.int(),
  email: z.string(),
  name: z.string(),
});

/** A failure with its stable code and its Turkish sentence. */
const authErrorSchema = z.object({
  code: z.enum(AUTH_ERROR_CODES),
  message: z.string(),
  retryAfterSeconds: z.int().nonnegative().optional(),
});

/** The whole state of the session as the renderer sees it. Unknown keys are dropped. */
const authStateSchema = z.object({
  status: z.enum(AUTH_STATUSES),
  user: authUserSchema.nullable(),
  error: authErrorSchema.nullable(),
  isRemembered: z.boolean(),
});

/** The answer of a sign-in: the user, or why there is none. */
const signInResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), user: authUserSchema }),
  z.object({ ok: z.literal(false), error: authErrorSchema }),
]);

/**
 * The IPC surface of this package, as a fragment of an app's contract: spread `invoke` and
 * `events` into the object given to `defineContract` of `@handijit/electron`. No channel takes
 * an input, and no schema has a field a token could travel in.
 */
const authContract = {
  invoke: {
    "auth:get-state": { output: authStateSchema },
    "auth:sign-in": { output: signInResultSchema },
    "auth:cancel-sign-in": {},
    "auth:sign-out": {},
  },
  events: {
    "auth:changed": authStateSchema,
  },
} as const;

/** The type of `authContract`, for `Handlers<AuthContract>` and `Client<AuthContract>`. */
type AuthContract = typeof authContract;

export type { AuthContract };
export {
  authContract,
  authErrorSchema,
  authStateSchema,
  authUserSchema,
  signInResultSchema,
};
