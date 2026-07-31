import { TryError } from "./errors.ts";
import {
  envFor,
  execInSandbox,
  filterArgs,
  type RunContext,
  type RunOptions,
  type RunRecord,
} from "./run.ts";
import { removeSandbox } from "./sandbox.ts";
import { runTry } from "./spawn.ts";
import { type FsChange, parseSummary } from "./summary.ts";
import { mergeTraces, type Trace } from "./trace.ts";

export type HandleState = "open" | "committed" | "discarded";

/**
 * A speculative sandbox: one or more commands whose filesystem effects are staged but not applied.
 *
 * Instrumentation is a property of each *run*, not of the handle — `try()` and `instrument()`
 * interleave freely in one sandbox — so `reads()`/`writes()` cover every traced run so far and
 * `traced` reports whether there was one.
 */
export class TryHandle {
  #ctx: RunContext;
  #runs: RunRecord[];
  #state: HandleState = "open";
  #trace?: Trace;

  /** @internal Built by `TryConsole`; the sandbox must already hold `runs`' effects. */
  constructor(
    ctx: RunContext,
    readonly sandbox: string,
    runs: RunRecord[],
  ) {
    this.#ctx = ctx;
    this.#runs = runs;
  }

  /** Every run staged in this sandbox, oldest first. */
  get runs(): readonly RunRecord[] {
    return this.#runs;
  }

  get state(): HandleState {
    return this.#state;
  }

  /** The most recent run's command; `runs` holds the full history. */
  get command(): string {
    return this.#runs.at(-1)!.command;
  }

  /** The most recent run's exit status — the command's own, never `try`'s. */
  get exitCode(): number {
    return this.#runs.at(-1)!.exitCode;
  }

  get stdout(): string {
    return this.#runs.at(-1)!.stdout;
  }

  get stderr(): string {
    return this.#runs.at(-1)!.stderr;
  }

  get traced(): boolean {
    return this.#runs.some((run) => run.trace !== undefined);
  }

  /** Stages another command on top of this sandbox; it sees every effect staged so far. */
  async try(cmd: string, opts?: RunOptions): Promise<void> {
    await this.#run(cmd, false, opts);
  }

  /** Same, but traced with `strace` so the run contributes to `reads()`/`writes()`. */
  async instrument(cmd: string, opts?: RunOptions): Promise<void> {
    await this.#run(cmd, true, opts);
  }

  async #run(cmd: string, trace: boolean, opts?: RunOptions): Promise<void> {
    if (this.#state !== "open") throw new TryError(`cannot run in a ${this.#state} handle`);
    // The sandbox survives a failed run: earlier runs stay inspectable and discardable.
    this.#runs.push(await execInSandbox(this.#ctx, this.sandbox, cmd, this.#runs.length, trace, opts));
    this.#trace = undefined;
  }

  /**
   * Folds other sandboxes' effects into this one, `Object.assign` style: with `h.merge(a, b)`
   * conflicts resolve `b` > `a` > `h`. Sources are left open and keep their own runs and traces.
   */
  async merge(...others: TryHandle[]): Promise<void> {
    if (others.length === 0) throw new TryError("merge requires at least one handle");
    if (this.#state !== "open") throw new TryError(`cannot merge into a ${this.#state} handle`);
    for (const other of others) {
      if (other.state !== "open") throw new TryError(`cannot merge a ${other.state} handle`);
      // `materialize_stack` would `rm -rf` the source before copying it back over itself.
      if (other.sandbox === this.sandbox) throw new TryError("cannot merge a handle into itself");
    }

    const before = [await this.changes(), ...(await Promise.all(others.map((o) => o.changes())))];
    const expected = new Set(before.flat().map((change) => change.path));

    // No command, so `try` takes its `materialize_stack` branch; the list is reversed because
    // upstream applies `-L` right-to-left, i.e. the leftmost entry wins.
    const sources = [...others]
      .reverse()
      .map((o) => o.sandbox)
      .join(":");
    const result = await this.#runTry(["-L", sources, "-N", this.sandbox, ...filterArgs(this.#ctx)]);
    if (result.exitCode !== 0) {
      throw new TryError("try merge failed", { exitCode: result.exitCode, stderr: result.stderr });
    }
    // `apply_upperdir_effect` ignores `cp`'s exit status and `materialize_stack` always exits 0,
    // so a dropped effect is otherwise silent. A merge only adds or overwrites, never removes.
    const after = new Set((await this.changes()).map((change) => change.path));
    const missing = [...expected].filter((path) => !after.has(path));
    if (missing.length > 0) throw new TryError(`merge lost effects: ${missing.join(", ")}`);
  }

  /**
   * Union of every traced run. Synchronous and captured at run time, so it stays available after
   * the sandbox is gone.
   */
  trace(): Trace {
    this.#trace ??= mergeTraces(this.#runs.flatMap((run) => run.trace ?? []));
    return this.#trace;
  }

  reads(): string[] {
    return this.trace().reads;
  }

  writes(): string[] {
    return this.trace().writes;
  }

  /** Cumulative filesystem effects staged by every run and merge in this sandbox. */
  async changes(): Promise<FsChange[]> {
    if (this.#state !== "open") throw new TryError(`cannot inspect a ${this.#state} handle`);

    const result = await this.#runTry([...filterArgs(this.#ctx), "summary", this.sandbox]);
    if (result.exitCode === 0) return parseSummary(result.stdout);
    if (result.exitCode === 1 && result.stdout.trim() === "") return [];
    throw new TryError("try summary failed", { exitCode: result.exitCode, stderr: result.stderr });
  }

  /** Applies the staged effects to the real filesystem and spends the handle. */
  async commit(): Promise<FsChange[]> {
    if (this.#state !== "open") throw new TryError(`cannot commit a ${this.#state} handle`);

    // Before committing: `try commit` moves the entries out of `upperdir`.
    const applied = await this.changes();

    // `-y` last among the flags, and mandatory: otherwise `try` prompts on stdin and, on EOF,
    // silently commits nothing.
    const result = await this.#runTry([...filterArgs(this.#ctx), "-y", "commit", this.sandbox]);
    if (result.exitCode !== 0) {
      throw new TryError("try commit failed", { exitCode: result.exitCode, stderr: result.stderr });
    }

    this.#state = "committed";
    await removeSandbox(this.sandbox);
    return applied;
  }

  /** Drops the overlay. Nothing was ever written to the real filesystem, so this *is* the undo. */
  async discard(): Promise<void> {
    if (this.#state === "committed") throw new TryError("cannot discard a committed handle");
    if (this.#state === "discarded") return;

    await removeSandbox(this.sandbox);
    this.#state = "discarded";
  }

  async [Symbol.asyncDispose](): Promise<void> {
    if (this.#state === "open") await this.discard();
  }

  #runTry(args: string[]) {
    return runTry([this.#ctx.bin, ...args], {
      cwd: this.#ctx.cwd,
      env: envFor(this.#ctx),
      stream: this.#ctx.stream,
    });
  }
}
