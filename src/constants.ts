/**
 * Absolute path prefix of the per-run file the SDK writes inside the sandbox to recover the
 * command's real exit status (`try -t` overwrites its own). Doubles as the `-E` pattern that keeps
 * the sentinel out of `changes()` and `commit()`; `try` matches `-E` unanchored, so the prefix
 * covers every `-<runIndex>` suffix.
 */
export const EXIT_SENTINEL_PREFIX = "/run/try-ts-exit";

/** Where `try` makes `strace` write its raw log inside the sandbox, before parsing it on the host. */
export const TRY_TRACE_LOG = "/run/try_trace.log";
