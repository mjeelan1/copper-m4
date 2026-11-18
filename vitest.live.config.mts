import { defineConfig } from "vitest/config";

// npm run test:live: the tests that talk to the real Supabase project
// (tests/*.live.test.ts). They need SUPABASE_URL and SUPABASE_SECRET_KEY in
// .env.local and are skipped without them.
// They live outside npm test because the public internet can lose a request
// (it happened once: a request never reached Supabase), and npm test should
// only fail when the code is wrong. Files run one at a time, and each test
// gets 30 seconds instead of 5, since one test makes a dozen round trips.
export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    environment: "node",
    include: ["tests/**/*.live.test.ts"],
    exclude: ["node_modules/**", ".next/**"],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
