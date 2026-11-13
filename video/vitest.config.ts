import { defineConfig } from "vitest/config";

// Rendering real video takes a while.
export default defineConfig({ test: { hookTimeout: 120_000, testTimeout: 180_000 } });
