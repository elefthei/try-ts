import { describe, expect, test } from "bun:test";
import { TryError } from "../src/errors.ts";
import { parseSummary } from "../src/summary.ts";

const header = "\nChanges detected in the following files:\n\n";

describe("parseSummary", () => {
  test("empty output means no changes", () => {
    expect(parseSummary("")).toEqual([]);
  });

  test("skips the header block", () => {
    expect(parseSummary(`${header}/a/b.txt (added)\n`)).toEqual([{ path: "/a/b.txt", kind: "added" }]);
  });

  test("maps every label try can emit", () => {
    expect(parseSummary("/a/b.txt (added)")).toEqual([{ path: "/a/b.txt", kind: "added" }]);
    expect(parseSummary("/a/b.txt (modified)")).toEqual([{ path: "/a/b.txt", kind: "modified" }]);
    expect(parseSummary("/a/b.txt (deleted)")).toEqual([{ path: "/a/b.txt", kind: "deleted" }]);
    expect(parseSummary("/a/b (created dir)")).toEqual([{ path: "/a/b", kind: "created-dir" }]);
    expect(parseSummary("/a/b (replaced with dir)")).toEqual([{ path: "/a/b", kind: "replaced-dir" }]);
    expect(parseSummary("/a/b (symlink)")).toEqual([{ path: "/a/b", kind: "symlink" }]);
  });

  test("keeps parentheses that belong to the path", () => {
    expect(parseSummary("/a/My Files (old)/b.txt (modified)")).toEqual([
      { path: "/a/My Files (old)/b.txt", kind: "modified" },
    ]);
  });

  test("preserves the order of multiple effects", () => {
    expect(parseSummary(`${header}/a/b.txt (added)\n/a/c.txt (deleted)\n`)).toEqual([
      { path: "/a/b.txt", kind: "added" },
      { path: "/a/c.txt", kind: "deleted" },
    ]);
  });

  test("throws rather than under-report an unknown label", () => {
    expect(() => parseSummary("/a/b.txt (exploded)")).toThrow(TryError);
  });

  test("throws rather than under-report an unparseable line", () => {
    expect(() => parseSummary("garbage")).toThrow(TryError);
  });
});
