import { configDefaults, defineConfig } from "vitest/config";

// The bot's tests only. The CRM (crm/) has its own package and runs its own tests: cd crm && npm test.
export default defineConfig({
  test: { exclude: [...configDefaults.exclude, "crm/**"] },
});
