// The Supabase client for the refund tables. Server code only: it uses the
// secret key, which skips row level security, so it must never reach the
// browser. That's why neither variable starts with NEXT_PUBLIC_.
// Returns null when Supabase isn't set up, so the app still builds and runs.
import { createClient } from "@supabase/supabase-js";

export function isRefundsConfigured(): boolean {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SECRET_KEY);
}

/** A request that gets no answer in this long fails instead of hanging. */
export const REQUEST_TIMEOUT_MS = 10_000;

/**
 * fetch with a time limit. Once in a while a request over the internet is
 * lost and never answered; without a limit the console or the chat would
 * wait for it forever. With one, it fails with a clear error. It is never
 * sent again: a refund request must not run twice by accident.
 */
export const fetchWithTimeout: typeof fetch = (input, init) => {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return fetch(input, {
    ...init,
    signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
  });
};

export function refundsDb() {
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SECRET_KEY?.trim();
  if (!url || !key) return null;
  return createClient(url, key, {
    auth: { persistSession: false },
    global: { fetch: fetchWithTimeout },
  });
}
