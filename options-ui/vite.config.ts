import path from "node:path";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import { validateEnv } from "./src/env.ts";

const optionsUiDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(optionsUiDir, "..");

/** `loadEnvFile` never overwrites, so most-specific files are read first. */
function tryLoadEnvFile(file: string): void {
  try {
    loadEnvFile(file);
  } catch {
    // optional
  }
}

function configEnvName(mode: string): string {
  if (mode === "hardhat") return "local";
  if (mode === "production") return "prd";
  return "dev";
}

/**
 * Vite passes string `define` values through as raw source (see `handleDefineValue` in Vite).
 * Non-strings are JSON-serialized; use explicit expressions when `import.meta.env.*` should not be a string literal.
 */
function importMetaEnvDefineLiteral(value: unknown): string {
  if (typeof value === "bigint") {
    return `BigInt(${JSON.stringify(value.toString())})`;
  }
  return JSON.stringify(value);
}

export default defineConfig(({ mode }) => {
  tryLoadEnvFile(path.resolve(optionsUiDir, ".env"));
  tryLoadEnvFile(path.resolve(repoRoot, ".env.local"));
  tryLoadEnvFile(path.resolve(repoRoot, ".env"));
  tryLoadEnvFile(path.resolve(repoRoot, `config/${configEnvName(mode)}.env`));
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
