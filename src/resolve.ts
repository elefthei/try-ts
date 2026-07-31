import { statSync } from "node:fs";
import { dirname, join } from "node:path";
import { TryError } from "./errors.ts";

export interface ResolvedTry {
  /** Absolute path to the `try` executable. */
  bin: string;
  /** Directory holding it; prepended to `PATH` so `try` finds its `try-parse-trace` helper. */
  dir: string;
}

/** First hit wins: explicit argument, `$TRY_BIN`, the vendored copy, then `try` on `PATH`. */
export function resolveTry(explicit?: string): ResolvedTry {
  const vendored = join(import.meta.dir, "..", "vendor", "try");
  const candidates = [
    explicit,
    process.env.TRY_BIN,
    statSync(vendored, { throwIfNoEntry: false })?.isFile() ? vendored : undefined,
    Bun.which("try"),
  ];

  for (const bin of candidates) {
    if (bin) return { bin, dir: dirname(bin) };
  }

  throw new TryError(
    "try not found: run `bun run vendor` to fetch the pinned copy, set TRY_BIN, or install https://github.com/binpash/try",
  );
}

/** Fails before any sandbox work when an instrumented run's prerequisites are missing. */
export function requireOnPath(names: string[], path: string): void {
  const missing = names.filter((name) => Bun.which(name, { PATH: path }) === null);
  if (missing.length > 0) {
    throw new TryError(`instrumented runs need ${missing.join(", ")} on PATH (e.g. pacman -S strace)`);
  }
}
