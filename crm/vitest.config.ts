import { defineConfig } from "vitest/config";

// Starting the local Postgres (PGlite) can take several seconds on a busy machine.
export default defineConfig({ test: { hookTimeout: 60_000, testTimeout: 30_000 } });
