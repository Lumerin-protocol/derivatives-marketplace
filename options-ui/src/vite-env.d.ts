/// <reference types="vite/client" />

import type { ClientEnv } from "./env.ts";

declare global {
  interface ImportMetaEnv extends ClientEnv {}
}

// biome-ignore lint/complexity/noUselessEmptyExport: biome doesn't understand the global declaration
export {};
