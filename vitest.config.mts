import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: { tsconfigPaths: true },
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    include: ["**/*.test.{ts,tsx}"],
    // Tests against the real Supabase project run with npm run test:live.
    exclude: ["node_modules/**", ".next/**", "tests/**/*.live.test.ts"],
  },
});
