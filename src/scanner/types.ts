/**
 * Public types for the scanner module.
 */

import type { CodexBindingRegistry } from "./codex-binding-registry.js";
import type { SessionRegistryRecord } from "./session-registry.js";

export interface ScanOptions {
  enrichmentMode?: "full" | "light";
  codexBindingRegistry?: CodexBindingRegistry;
  sessionRegistry?: Map<string, SessionRegistryRecord>;
}
