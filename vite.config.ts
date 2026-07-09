import { defineConfig } from "vite";

export default defineConfig({
  // Relative asset paths so the built site works at any URL prefix
  // (user.github.io/repo/, custom domain root, /preview/, etc.) without
  // having to hard-code the repo name.
  base: "./",
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
