import { useAuth } from "@handijit/auth/react";
import { getAuthStore } from "@handijit/auth/renderer";
import { createElement, StrictMode } from "react";
import { createRoot } from "react-dom/client";

// The page's half of the smoke test: a sign-in screen as a program writes one, with the hook,
// under StrictMode. Main drives it by clicking its buttons and reads what it rendered.
const smoke = {
  // Every status the screen rendered, without the repeats of a double render.
  statuses: [],
  // What each signIn() resolved with.
  results: [],
  // What the store of the renderer entry says; the hook's entry is a separate bundle.
  storeState: () => getAuthStore().getState(),
  bridge: () => ({
    keys: Object.keys(window.desktop).sort(),
    invoke: Object.keys(window.desktop.invoke).sort(),
    on: Object.keys(window.desktop.on).sort(),
  }),
  hasNode:
    typeof require !== "undefined" ||
    typeof process !== "undefined" ||
    typeof module !== "undefined" ||
    typeof Buffer !== "undefined",
};
window.__smoke = smoke;

const Screen = () => {
  const auth = useAuth();
  if (smoke.statuses.at(-1) !== auth.status) smoke.statuses.push(auth.status);
  return createElement(
    "main",
    { id: "screen", "data-status": auth.status },
    createElement("p", { id: "name" }, auth.user?.name ?? ""),
    createElement("p", { id: "error" }, auth.error?.message ?? ""),
    createElement("p", { id: "code" }, auth.error?.code ?? ""),
    createElement(
      "button",
      {
        id: "sign-in",
        onClick: () => {
          void auth.signIn().then((result) => smoke.results.push(result));
        },
      },
      "Tarayıcıyla giriş yap"
    ),
    createElement(
      "button",
      { id: "cancel", onClick: () => void auth.cancelSignIn() },
      "Vazgeç"
    ),
    createElement(
      "button",
      { id: "sign-out", onClick: () => void auth.signOut() },
      "Çıkış yap"
    )
  );
};

// A second component with the hook: both share the page's one store.
const Badge = () => {
  const { status } = useAuth();
  return createElement("span", { id: "badge" }, status);
};

createRoot(document.getElementById("root")).render(
  createElement(StrictMode, null, createElement(Screen), createElement(Badge))
);
