import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { TryError } from "./errors.ts";
import { TryHandle } from "./handle.ts";
import { resolveTry } from "./resolve.ts";
import { execInSandbox, type RunContext, type RunOptions } from "./run.ts";
import { createSandbox, removeSandbox } from "./sandbox.ts";

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

  /** Runs `cmd` in a fresh sandbox; nothing reaches the real filesystem until `commit()`. */
  try(cmd: string, opts?: RunOptions): Promise<TryHandle> {
    return this.#start(cmd, false, opts);
  }

  /** Same, but traced with `strace`, so the handle also reports `reads()`/`writes()`. */
  instrument(cmd: string, opts?: RunOptions): Promise<TryHandle> {
    return this.#start(cmd, true, opts);
  }

  async #start(cmd: string, trace: boolean, opts?: RunOptions): Promise<TryHandle> {
    const sandbox = await createSandbox(this.#sandboxRoot);
    try {
      // The console owns the sandbox it just created, so a setup failure must not leak it.
      const record = await execInSandbox(this.context, sandbox, cmd, 0, trace, opts);
      return new TryHandle(this.context, sandbox, [record]);
    } catch (error) {
      await removeSandbox(sandbox);
      throw error;
    }
  }
}
