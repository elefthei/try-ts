import { EXIT_SENTINEL_PREFIX, TRY_TRACE_LOG } from "./constants.ts";
import { TryError } from "./errors.ts";

/** Syscall-level view of one or more instrumented runs. Both sides are sorted and de-duplicated. */
export interface Trace {
  reads: string[];
  writes: string[];
}

/**
 * Parses the file `try -t PATH` produces: a `#reads` section, a `#writes` section, one absolute
 * path per line. Upstream emits Python-set order, so both sides are sorted here.
 */
export function parseTrace(text: string): Trace {
  const reads: string[] = [];
  const writes: string[] = [];
  let target: string[] | undefined;

  for (const line of text.split("\n")) {
    if (line === "") continue;
    if (line === "#reads") target = reads;
    else if (line === "#writes") target = writes;
    else if (target === undefined) throw new TryError("malformed trace file: content before #reads/#writes");
    else target.push(line);
  }

  return { reads: reads.sort(), writes: writes.sort() };
}

export function mergeTraces(traces: Trace[]): Trace {
  const reads = new Set<string>();
  const writes = new Set<string>();

  for (const trace of traces) {
    for (const path of trace.reads) reads.add(path);
    for (const path of trace.writes) writes.add(path);
  }

  return { reads: [...reads].sort(), writes: [...writes].sort() };
}

/** Drops the SDK's own exit sentinel and `try`'s raw strace log, which no caller asked about. */
export function stripInternal(trace: Trace): Trace {
  const keep = (path: string) => !path.startsWith(EXIT_SENTINEL_PREFIX) && path !== TRY_TRACE_LOG;
  return { reads: trace.reads.filter(keep), writes: trace.writes.filter(keep) };
}
