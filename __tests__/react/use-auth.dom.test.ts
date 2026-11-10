import { act, createElement, Fragment, StrictMode, useState } from "react";
import type { ReactElement } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import useAuth from "../../lib/react/use-auth";
import type { UseAuth } from "../../lib/react/use-auth";
import installBridge, { forgetStore } from "../support/fake-bridge";

const USER = { id: 41, email: "ayse@example.com", name: "Ayşe Yılmaz" };
const SIGNED_OUT = {
  status: "signed-out",
  user: null,
  error: null,
  isRemembered: false,
};
const SIGNING_IN = { ...SIGNED_OUT, status: "signing-in" };
const SIGNED_IN = {
  status: "signed-in",
  user: USER,
  error: null,
  isRemembered: true,
};

let container: HTMLElement;
let root: Root;

/** What a component saw, render by render. StrictMode renders twice; both are recorded. */
type Probe = { renders: UseAuth[]; latest: () => UseAuth };

const createProbe = (): Probe => {
  const renders: UseAuth[] = [];
  return { renders, latest: () => renders.at(-1) as UseAuth };
};

/** A screen as a program writes one: the name, the error, a button per action. */
const Screen = ({ probe }: { probe: Probe }): ReactElement => {
  const auth = useAuth();
  probe.renders.push(auth);
  return createElement(
    "main",
    { "data-status": auth.status },
    createElement("p", { id: "name" }, auth.user?.name ?? ""),
    createElement("p", { id: "error" }, auth.error?.message ?? "")
  );
};

/** The statuses a component went through, without the repeats of a double render. */
const statusesOf = (probe: Probe): string[] =>
  probe.renders
    .map((render) => render.status)
    .filter((status, index, all) => status !== all[index - 1]);

const render = async (element: ReactElement): Promise<void> => {
  await act(async () => {
    root.render(createElement(StrictMode, null, element));
    await Promise.resolve();
  });
};

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  forgetStore();
});

describe("useAuth", () => {
  test("should render loading first and the real state second, with nothing in between", async () => {
    const bridge = installBridge(SIGNED_IN);
    const release = bridge.hold("auth:get-state");
    const probe = createProbe();

    await render(createElement(Screen, { probe }));
    expect(statusesOf(probe)).toEqual(["loading"]);
    expect(container.querySelector("main")?.dataset.status).toBe("loading");

    await act(async () => {
      release(SIGNED_IN);
      await Promise.resolve();
    });

    expect(statusesOf(probe)).toEqual(["loading", "signed-in"]);
    expect(container.querySelector("#name")?.textContent).toBe("Ayşe Yılmaz");
    expect(probe.latest()).toMatchObject(SIGNED_IN);
  });

  test("should ask main once and listen once under StrictMode, for any number of components", async () => {
    const bridge = installBridge();
    const probes = [createProbe(), createProbe(), createProbe()];

    await render(
      createElement(
        Fragment,
        null,
        ...probes.map((probe, index) =>
          createElement(Screen, { probe, key: index })
        )
      )
    );

    expect(bridge.calls).toEqual(["auth:get-state"]);
    expect(bridge.subscriptions()).toBe(1);
    expect(bridge.listenerCount()).toBe(1);
    for (const probe of probes) {
      expect(statusesOf(probe)).toEqual(["loading", "signed-out"]);
    }
  });

  test("should show every component the change main announces", async () => {
    const bridge = installBridge();
    const first = createProbe();
    const second = createProbe();
    await render(
      createElement(
        Fragment,
        null,
        createElement(Screen, { probe: first }),
        createElement(Screen, { probe: second })
      )
    );

    act(() => bridge.emit(SIGNING_IN));
    act(() => bridge.emit(SIGNED_IN));

    const expected = ["loading", "signed-out", "signing-in", "signed-in"];
    expect(statusesOf(first)).toEqual(expected);
    expect(statusesOf(second)).toEqual(expected);
  });

  test("should keep the identity of what it returns until the state changes", async () => {
    installBridge();
    const probe = createProbe();
    let rerender!: () => void;
    const Parent = (): ReactElement => {
      const [, setCount] = useState(0);
      rerender = () => setCount((count) => count + 1);
      return createElement(Screen, { probe });
    };
    await render(createElement(Parent));
    const before = probe.latest();

    act(() => rerender());
    act(() => rerender());

    expect(probe.renders.length).toBeGreaterThan(3);
    expect(probe.latest()).toBe(before);
    expect(probe.latest().signIn).toBe(before.signIn);
  });

  test("should keep the actions the same functions across a change of the state", async () => {
    const bridge = installBridge();
    const probe = createProbe();
    await render(createElement(Screen, { probe }));
    const { signIn, cancelSignIn, signOut } = probe.latest();

    act(() => bridge.emit(SIGNED_IN));

    expect(probe.latest().signIn).toBe(signIn);
    expect(probe.latest().cancelSignIn).toBe(cancelSignIn);
    expect(probe.latest().signOut).toBe(signOut);
  });

  test("should run a sign-in from a component: the browser opens, the customer comes back", async () => {
    const bridge = installBridge();
    const release = bridge.hold("auth:sign-in");
    const probe = createProbe();
    await render(createElement(Screen, { probe }));

    let outcome: unknown;
    await act(async () => {
      void probe
        .latest()
        .signIn()
        .then((result) => {
          outcome = result;
        });
      await Promise.resolve();
    });
    act(() => bridge.emit(SIGNING_IN));
    expect(container.querySelector("main")?.dataset.status).toBe("signing-in");

    await act(async () => {
      bridge.emit(SIGNED_IN);
      release({ ok: true, user: USER });
      await Promise.resolve();
    });

    expect(outcome).toEqual({ ok: true, user: USER });
    expect(statusesOf(probe)).toEqual([
      "loading",
      "signed-out",
      "signing-in",
      "signed-in",
    ]);
  });

  test("should show the last error with its Turkish sentence and its code", async () => {
    const bridge = installBridge();
    const probe = createProbe();
    await render(createElement(Screen, { probe }));

    act(() =>
      bridge.emit({
        ...SIGNED_OUT,
        error: {
          code: "RATE_LIMITED",
          message: "Çok fazla deneme yapıldı. 2 dakika sonra yeniden deneyin.",
          retryAfterSeconds: 120,
        },
      })
    );

    expect(probe.latest().error?.code).toBe("RATE_LIMITED");
    expect(probe.latest().error?.retryAfterSeconds).toBe(120);
    expect(container.querySelector("#error")?.textContent).toBe(
      "Çok fazla deneme yapıldı. 2 dakika sonra yeniden deneyin."
    );
  });

  test("should send cancel and sign-out to main", async () => {
    const bridge = installBridge(SIGNED_IN);
    const probe = createProbe();
    await render(createElement(Screen, { probe }));

    await act(async () => {
      await probe.latest().cancelSignIn();
      await probe.latest().signOut();
    });

    expect(bridge.calls).toEqual([
      "auth:get-state",
      "auth:cancel-sign-in",
      "auth:sign-out",
    ]);
  });

  test("should render the current state at once in a component that mounts later", async () => {
    const bridge = installBridge(SIGNED_IN);
    await render(createElement(Screen, { probe: createProbe() }));
    await render(createElement("p"));

    const late = createProbe();
    await render(createElement(Screen, { probe: late }));

    // No second loading and no second question: the page's store stayed connected.
    expect(statusesOf(late)).toEqual(["signed-in"]);
    expect(bridge.calls).toEqual(["auth:get-state"]);
    expect(bridge.subscriptions()).toBe(1);
  });

  test("should ignore what main sends once the component is gone", async () => {
    const bridge = installBridge();
    const probe = createProbe();
    await render(createElement(Screen, { probe }));
    await render(createElement("p"));
    const count = probe.renders.length;

    act(() => bridge.emit(SIGNED_IN));

    expect(probe.renders).toHaveLength(count);
  });

  test("should render loading where there is no window at all", () => {
    const probe = createProbe();
    const html = renderToString(createElement(Screen, { probe }));

    expect(html).toContain('data-status="loading"');
  });
});
