import { defineConfig } from "vitest/config";
import path from "node:path";

/**
 * The alias has to match vite.config.ts exactly. A test suite that resolves `@/`
 * differently from the bundle is testing a different program — and the way that
 * shows up is a green suite beside a broken page.
 *
 * No jsdom: everything under test here is pure. Rendering logic that needs a DOM
 * is extracted into functions that do not, which is why it can be tested at all.
 */
export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
