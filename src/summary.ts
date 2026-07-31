import { TryError } from "./errors.ts";

export type ChangeKind = "added" | "modified" | "deleted" | "created-dir" | "replaced-dir" | "symlink";

/** One filesystem effect staged in a sandbox, as `try summary` reports it. `path` is a host path. */
export interface FsChange {
  path: string;
  kind: ChangeKind;
}

const HEADER = "Changes detected in the following files:";

/** `try summary` labels; identical in the shell implementation and the C `try-summary` util. */
const LABELS: Record<string, ChangeKind> = {
  added: "added",
  modified: "modified",
  deleted: "deleted",
  "created dir": "created-dir",
  "replaced with dir": "replaced-dir",
  symlink: "symlink",
};

/**
 * Parses `try summary DIR` output.
 *
 * Throws on anything unrecognised: silently dropping a line would under-report what `commit()` is
 * about to apply to the real filesystem.
 */
export function parseSummary(stdout: string): FsChange[] {
  const changes: FsChange[] = [];

  for (const line of stdout.split("\n")) {
    if (line.trim() === "" || line.trim() === HEADER) continue;

    // Greedy `.*` so parentheses inside a filename stay with the path.
    const match = /^(.*) \(([^()]+)\)$/.exec(line);
    const kind = match ? LABELS[match[2]!] : undefined;
    if (!match || kind === undefined) throw new TryError(`unparseable summary line: ${line}`);

    changes.push({ path: match[1]!, kind });
  }

  return changes;
}
