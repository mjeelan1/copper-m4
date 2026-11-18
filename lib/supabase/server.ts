// The Supabase client for the refund tables. Server code only: it uses the
// secret key, which skips row level security, so it must never reach the
// browser. That's why neither variable starts with NEXT_PUBLIC_.
// Returns null when Supabase isn't set up, so the app still builds and runs.
import { createClient } from "@supabase/supabase-js";

export function isRefundsConfigured(): boolean {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SECRET_KEY);
}

export function refundsDb() {
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SECRET_KEY?.trim();
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}
