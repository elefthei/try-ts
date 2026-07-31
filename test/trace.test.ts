import { describe, expect, test } from "bun:test";
import { TryError } from "../src/errors.ts";
import { mergeTraces, parseTrace, stripInternal } from "../src/trace.ts";

describe("parseTrace", () => {
  test("splits reads from writes and sorts both", () => {
    expect(parseTrace("#reads\n/b\n/a\n#writes\n/c\n")).toEqual({ reads: ["/a", "/b"], writes: ["/c"] });
  });

  test("tolerates an empty section", () => {
    expect(parseTrace("#reads\n/a\n#writes\n")).toEqual({ reads: ["/a"], writes: [] });
  });

  test("throws on content before any section header", () => {
    expect(() => parseTrace("/a\n#reads\n")).toThrow(TryError);
  });

  test("empty input is an empty trace", () => {
    expect(parseTrace("")).toEqual({ reads: [], writes: [] });
  });
});

describe("mergeTraces", () => {
  test("unions both sides without duplicates", () => {
    expect(
      mergeTraces([
        { reads: ["/a"], writes: [] },
        { reads: ["/a", "/b"], writes: ["/c"] },
      ]),
    ).toEqual({ reads: ["/a", "/b"], writes: ["/c"] });
  });
});

describe("stripInternal", () => {
  test("hides the SDK's exit sentinel and try's own trace log", () => {
    expect(
      stripInternal({
        reads: ["/run/try-ts-exit-0", "/a"],
        writes: ["/run/try-ts-exit-1", "/run/try_trace.log", "/b"],
      }),
    ).toEqual({ reads: ["/a"], writes: ["/b"] });
  });
});
