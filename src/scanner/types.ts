/**
 * Public types for the scanner module.
 */

export interface ScanOptions {
  enrichmentMode?: "full" | "light";
  includeTokenUsage?: boolean;
  includeStdoutHeuristic?: boolean;
}
