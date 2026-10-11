// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useResource } from "../src/components/ui";

afterEach(cleanup);

describe("useResource", () => {
  it("does not keep what the last key said, its data or its error, for the key that replaced it while that one loads", async () => {
    let finish: (value: string) => void = () => {};
    const loads: Record<string, () => Promise<string>> = {
      a: () => Promise.reject(new Error("a failed")),
      b: () => new Promise<string>((resolve) => (finish = resolve)),
    };
    const { result, rerender } = renderHook(({ key }) => useResource(loads[key]!, key), { initialProps: { key: "a" } });
    await waitFor(() => expect((result.current.error as Error | null)?.message).toBe("a failed"));

    rerender({ key: "b" });
    await waitFor(() => expect(result.current.error).toBeNull());
    expect(result.current.data).toBeUndefined();
    expect(result.current.loading).toBe(true);

    await act(async () => finish("b loaded"));
    await waitFor(() => expect(result.current.data).toBe("b loaded"));
    expect(result.current.error).toBeNull();
  });

  it("drops an answer that arrives after a newer load started", async () => {
    const resolvers: Array<(value: string) => void> = [];
    const { result } = renderHook(() => useResource(() => new Promise<string>((resolve) => resolvers.push(resolve)), "one"));
    await waitFor(() => expect(resolvers).toHaveLength(1));
    act(() => result.current.reload());
    await waitFor(() => expect(resolvers).toHaveLength(2));
    await act(async () => resolvers[1]!("newer"));
    await act(async () => resolvers[0]!("older"));
    expect(result.current.data).toBe("newer");
  });

  it("returns the same object until one of its fields changes, so what is built from it is not rebuilt for nothing", async () => {
    let finish: (value: string) => void = () => {};
    const { result, rerender } = renderHook(() => useResource(() => new Promise<string>((resolve) => (finish = resolve)), "one"));
    const loading = result.current;
    rerender();
    expect(result.current).toBe(loading);
    await act(async () => finish("loaded"));
    await waitFor(() => expect(result.current.data).toBe("loaded"));
    const loaded = result.current;
    expect(loaded).not.toBe(loading);
    rerender();
    rerender();
    expect(result.current).toBe(loaded);
  });
});
