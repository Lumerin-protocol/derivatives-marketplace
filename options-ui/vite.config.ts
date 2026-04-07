import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import { validateEnv } from "./src/env.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Vite passes string `define` values through as raw source (see `handleDefineValue` in Vite).
 * Non-strings are JSON-serialized; use explicit expressions when `import.meta.env.*` should not be a string literal.
 */
function importMetaEnvDefineLiteral(value: unknown): string {
  if (value instanceof URL) {
    return `new URL(${JSON.stringify(value.href)})`;
  }
  if (typeof value === "bigint") {
    return `BigInt(${JSON.stringify(value.toString())})`;
  }
  return JSON.stringify(value);
}

export default defineConfig(({ mode }) => {
  const loaded = loadEnv(mode, repoRoot, "");

  const validated = validateEnv(loaded);

  const define: Record<string, string> = {};
  for (const [key, value] of Object.entries(validated)) {
    define[`import.meta.env.${key}`] = importMetaEnvDefineLiteral(value);
  }
  return {
    plugins: [react()],
    envDir: repoRoot,
    define,
    server: {
      port: 5173,
    },
  };
});
