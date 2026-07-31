import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { EXIT_SENTINEL_PREFIX } from "./constants.ts";
import { TryError } from "./errors.ts";
import { requireOnPath } from "./resolve.ts";
import { runTry } from "./spawn.ts";
import { parseTrace, stripInternal, type Trace } from "./trace.ts";

/** Everything a run needs that is fixed for the lifetime of a `TryConsole`. */
export interface RunContext {
  bin: string;
  binDir: string;
  cwd: string;
  env: Record<string, string>;
  shell: string;
  include: string[];
  exclude: string[];
  network: boolean;
  unionHelper?: string;
  stream: boolean;
}

/**
 * Per-run overrides. Deliberately no `include`/`exclude`: filters define what the sandbox will
 * commit, so letting one run diverge would silently change the commit set of every other run.
 */
export interface RunOptions {
  env?: Record<string, string>;
  network?: boolean;
  stream?: boolean;
}

export interface RunRecord {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  trace?: Trace;
}

/**
 * `-E`/`-I` arguments. `try` rebuilds its filter files from scratch on every invocation, so these
 * must be repeated on runs, summaries, commits and merges alike — omitting them from a commit
 * would leak the exit sentinel onto the real filesystem.
 */
export function filterArgs(ctx: RunContext): string[] {
  return [
    "-E",
    EXIT_SENTINEL_PREFIX,
    ...ctx.exclude.flatMap((pattern) => ["-E", pattern]),
    ...ctx.include.flatMap((pattern) => ["-I", pattern]),
  ];
}

/**
 * Merged over `process.env`, never replacing it: `try` shells out to `mktemp`, `find`, `getfattr`
 * and `unshare`, so a stripped `PATH` breaks it before the command ever runs.
 */
export function envFor(ctx: RunContext, opts?: RunOptions): Record<string, string> {
  const basePath = opts?.env?.PATH ?? ctx.env.PATH ?? process.env.PATH ?? "";
  return {
    ...(process.env as Record<string, string>),
    ...ctx.env,
    ...opts?.env,
    TRY_SHELL: ctx.shell,
    PATH: `${ctx.binDir}:${basePath}`,
  };
}

/**
 * Wraps the command so its real exit status survives.
 *
 * `try -t` overwrites `TRY_EXIT_STATUS` with the trace parser's status, and `try` also exits
 * non-zero for its own setup failures, so the child writes its status to a sandbox-local file the
 * host reads back. A missing sentinel is exactly how "`try` never ran the command" is detected.
 * The newlines stop a trailing `# comment` in the user's command from swallowing the epilogue.
 */
function wrap(cmd: string, sentinel: string): string {
  return `{
${cmd}
}
__try_ts_status=$?
printf %s "$__try_ts_status" > ${sentinel} 2>/dev/null
exit "$__try_ts_status"
`;
}

/** The one execution path shared by `TryConsole` (first run) and `TryHandle` (staged runs). */
export async function execInSandbox(
  ctx: RunContext,
  sandbox: string,
  cmd: string,
  runIndex: number,
  trace: boolean,
  opts?: RunOptions,
): Promise<RunRecord> {
  const env = envFor(ctx, opts);
  if (trace) requireOnPath(["strace", "python3"], env.PATH!);

  // Per-run, so a stale sentinel from run n-1 is never read as run n's result.
  const sentinel = `${EXIT_SENTINEL_PREFIX}-${runIndex}`;
  const tracePath = join(sandbox, `trace-${runIndex}.txt`);

  // Options strictly before the command, and never `-y`: a run must not commit.
  const argv = [
    ctx.bin,
    "-N",
    sandbox,
    ...filterArgs(ctx),
    ...((opts?.network ?? ctx.network) ? [] : ["-x"]),
    ...(ctx.unionHelper ? ["-U", ctx.unionHelper] : []),
    ...(trace ? ["-t", tracePath] : []),
    wrap(cmd, sentinel),
  ];

  const result = await runTry(argv, { cwd: ctx.cwd, env, stream: opts?.stream ?? ctx.stream });

  const status = await readFile(join(sandbox, "upperdir", sentinel), "utf8").catch(() => undefined);
  const exitCode = status === undefined ? Number.NaN : Number.parseInt(status, 10);
  if (!Number.isInteger(exitCode)) {
    throw new TryError(`try failed to run the command (exit ${result.exitCode})`, {
      exitCode: result.exitCode,
      stderr: result.stderr,
      command: cmd,
    });
  }

  const record: RunRecord = { command: cmd, exitCode, stdout: result.stdout, stderr: result.stderr };

  if (trace) {
    // Read eagerly: trace data must outlive the sandbox that commit()/discard() deletes.
    const text = await readFile(tracePath, "utf8").catch(() => undefined);
    if (text === undefined) {
      throw new TryError(`trace file missing: ${tracePath} (strace or try-parse-trace failed)`, {
        stderr: result.stderr,
        command: cmd,
      });
    }
    record.trace = stripInternal(parseTrace(text));
  }

  return record;
}
