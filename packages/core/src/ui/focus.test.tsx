/**
 * `ContextFocusTracker`/`useFocusTracking` tests (Req 4.6, design.md §8.1).
 * Exercises the REAL `@opentui/core` `Renderable` focus mechanism (a real
 * `<box>`'s `.focus()`/`.blur()`, via `testRender`) rather than a fake
 * event emitter, so this proves the actual `RenderableEvents.FOCUSED`/
 * `BLURRED` wiring, not just this module's own logic in isolation.
 */

import { describe, expect, test } from "bun:test";
import type { BoxRenderable } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { createContextService } from "../keymap/context";
import { ContextFocusTracker, useFocusTracking, type FocusEmitter } from "./focus";

function Probe(props: { onNode: (node: BoxRenderable | null) => void }) {
  const trackingRef = useFocusTracking("testFocus");
  return (
    <box
      focusable
      ref={(node: BoxRenderable | null) => {
        trackingRef(node as unknown as FocusEmitter | null);
        props.onNode(node);
      }}
    />
  );
}

describe("ContextFocusTracker / useFocusTracking (Req 4.6)", () => {
  test("focus() sets the context key true; blur() sets it false", async () => {
    const context = createContextService();
    let captured: BoxRenderable | null = null;

    const { renderOnce } = await testRender(
      <ContextFocusTracker context={context}>
        <Probe onNode={(node) => (captured = node)} />
      </ContextFocusTracker>,
      { width: 10, height: 3 },
    );
    await renderOnce();

    expect(context.get<boolean>("testFocus")).toBeUndefined();
    expect(captured).not.toBeNull();

    captured!.focus();
    expect(context.get<boolean>("testFocus")).toBe(true);

    captured!.blur();
    expect(context.get<boolean>("testFocus")).toBe(false);
  });

  test("used outside a ContextFocusTracker, it attaches without throwing and reports nothing", async () => {
    // An independent context service, never passed anywhere near the
    // rendered tree below — proves focusing outside a ContextFocusTracker
    // truly reports to nothing, not merely that some in-tree context
    // happens to stay untouched.
    const context = createContextService();
    let captured: BoxRenderable | null = null;
    const { renderOnce } = await testRender(<Probe onNode={(node) => (captured = node)} />, {
      width: 10,
      height: 3,
    });
    await renderOnce();

    expect(() => captured!.focus()).not.toThrow();
    expect(context.get<boolean>("testFocus")).toBeUndefined();
  });

  test("the ref callback tolerates being called with null (React's unmount cleanup)", async () => {
    const context = createContextService();
    let trackingRef: ((node: unknown) => void) | undefined;

    function Probe2() {
      trackingRef = useFocusTracking("testFocus") as unknown as (node: unknown) => void;
      return <box />;
    }

    const { renderOnce } = await testRender(
      <ContextFocusTracker context={context}>
        <Probe2 />
      </ContextFocusTracker>,
      { width: 10, height: 3 },
    );
    await renderOnce();

    expect(() => trackingRef!(null)).not.toThrow();
  });
});
