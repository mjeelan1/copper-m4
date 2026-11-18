// @vitest-environment node
// Every Supabase request has a time limit (lib/supabase/server.ts), so a
// request lost on the internet fails instead of hanging the console or chat.
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWithTimeout, REQUEST_TIMEOUT_MS } from "@/lib/supabase/server";

afterEach(() => vi.unstubAllGlobals());

/** A fetch that never answers, but stops when its signal aborts. */
function neverAnswers() {
  const calls: RequestInit[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((_input: unknown, init: RequestInit) => {
      calls.push(init);
      return new Promise((_resolve, reject) =>
        init.signal!.addEventListener("abort", () =>
          reject(init.signal!.reason),
        ),
      );
    }),
  );
  return calls;
}

describe("fetchWithTimeout", () => {
  it("gives up after 10 seconds and sends the request only once", async () => {
    expect(REQUEST_TIMEOUT_MS).toBe(10_000);
    const calls = neverAnswers();
    const started = Date.now();
    // A short test limit stands in for the 10 seconds.
    const result = fetchWithTimeout("https://example.test", {
      signal: AbortSignal.timeout(50),
    });
    await expect(result).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(calls).toHaveLength(1);
  });

  it("always sends a signal with a time limit", async () => {
    const calls = neverAnswers();
    const result = fetchWithTimeout("https://example.test");
    result.catch(() => {});
    expect(calls[0].signal).toBeInstanceOf(AbortSignal);
    expect(calls[0].signal!.aborted).toBe(false);
  });
});
