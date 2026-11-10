/** Every value of `AuthState.status`, in the order a start-up goes through them. */
const AUTH_STATUSES = [
  "loading",
  "signed-out",
  "signing-in",
  "signed-in",
] as const;

export default AUTH_STATUSES;
