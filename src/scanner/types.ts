/**
 * Public types for the scanner module.
 */

import type { CodexBindingRegistry } from "./codex-binding-registry.js";

export interface ScanOptions {
  enrichmentMode?: "full" | "light";
  codexBindingRegistry?: CodexBindingRegistry;
}
