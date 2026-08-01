import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { TryError } from "./errors.ts";
import { TryHandle } from "./handle.ts";
import { resolveTry } from "./resolve.ts";
import type { RunContext } from "./run.ts";
import { createSandbox, openSandbox } from "./sandbox.ts";

export interface TryConsoleOptions {
  /** Overrides `try` resolution (`$TRY_BIN`, the vendored copy, then `PATH`). */
  tryBin?: string;
  /** `TRY_SHELL` for every run; default `/bin/sh`, so traced and untraced runs use the same shell. */
  shell?: string;
  /** Where sandboxes are created; default `os.tmpdir()`. Must not contain `:`. */
  sandboxRoot?: string;
  /** `-I` patterns: unanchored regexes matched against host paths. */
  include?: string[];
  /** `-E` patterns, same matching. The SDK always excludes its own exit sentinel. */
  exclude?: string[];
  /** Default `true`; `false` runs commands with `-x` (no network namespace access). */
  network?: boolean;
  /** `-U PATH` (mergerfs/unionfs) for hosts where plain overlay mounts fail. */
  unionHelper?: string;
  /** Tee child output to this process's stdout/stderr while still capturing it. */
  stream?: boolean;
}

/**
 * Speculative execution rooted at a working directory.
 *
 * Effects are captured filesystem-wide, not scoped to `path`: `try` overlays the whole root, so a
 * command writing elsewhere still shows up in `changes()` and still gets committed. Scope that
 * deliberately with `include`.
 */
export class TryConsole {
  readonly path: string;
  readonly context: RunContext;
  readonly #sandboxRoot: string;

  constructor(path: string, env: Record<string, string> = {}, options: TryConsoleOptions = {}) {
    this.path = resolve(path);
    if (!statSync(this.path, { throwIfNoEntry: false })?.isDirectory()) {
      throw new TryError(`not a directory: ${path}`);
    }

    // Eagerly, so a missing `try` fails at construction with an actionable message.
    const { bin, dir } = resolveTry(options.tryBin);

    this.#sandboxRoot = options.sandboxRoot ?? tmpdir();
    this.context = Object.freeze({
      bin,
      binDir: dir,
      cwd: this.path,
      env,
      shell: options.shell ?? "/bin/sh",
      include: options.include ?? [],
      exclude: options.exclude ?? [],
      network: options.network ?? true,
      unionHelper: options.unionHelper,
      stream: options.stream ?? false,
    });
  }

  /**
   * Opens a sandbox and returns a handle with no runs yet. Pass `sandbox` to pin the location or
   * re-attach to an existing sandbox; omitted, one is created under `sandboxRoot`.
   */
  async create(sandbox?: string): Promise<TryHandle> {
    const dir = sandbox === undefined ? await createSandbox(this.#sandboxRoot) : await openSandbox(sandbox);
    return new TryHandle(this.context, dir);
  }
}
