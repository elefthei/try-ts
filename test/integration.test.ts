import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { TryConsole, TryError, type TryHandle } from "../src/index.ts";

const T = 120_000; // overlay setup is slow; bun's 5s default is not enough
const WRITE = 'echo "foo" > file.txt';
const READ = "cat file.txt";
const suite = process.env.TRY_TS_INTEGRATION === "1" ? describe : describe.skip;
const traced = Bun.which("strace") ? test : test.skip;

suite("try-ts", () => {
  let dir: string;
  let tryc: TryConsole;
  const open: TryHandle[] = [];

  // Working directory lives under $HOME while sandboxes live under /tmp: `try` overlays each
  // root-level directory separately and needs the one holding the sandbox for its own scripts.
  beforeEach(() => {
    dir = mkdtempSync(join(homedir(), ".try-ts-test-"));
    tryc = new TryConsole(dir, {}, { sandboxRoot: tmpdir() });
  });

  afterEach(async () => {
    for (const h of open.splice(0)) if (h.state === "open") await h.discard();
    rmSync(dir, { recursive: true, force: true });
  }, T);

  // Pushed onto `open` before the run: a failed first run no longer self-deletes its sandbox.
  const stage = async (cmd: string) => {
    const h = await tryc.create();
    open.push(h);
    await h.try(cmd);
    return h;
  };
  const stageTraced = async (cmd: string) => {
    const h = await tryc.create();
    open.push(h);
    await h.instrument(cmd);
    return h;
  };
  const file = (name = "file.txt") => join(dir, name);

  test(
    "try stages a write without touching disk",
    async () => {
      const h = await stage(WRITE);
      expect(h.exitCode).toBe(0);
      expect(h.runs.length).toBe(1);
      expect(await h.changes()).toEqual([{ path: file(), kind: "added" }]);
      expect(existsSync(file())).toBe(false);
      expect(h.reads()).toEqual([]); // untraced handles expose effects only
      expect(h.traced).toBe(false);
    },
    T,
  );

  test(
    "a separate sandbox does not see another's staged write",
    async () => {
      await stage(WRITE);
      const r = await stage(READ);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("No such file or directory");
      expect(await r.changes()).toEqual([]);
    },
    T,
  );

  test(
    "handle.try stages onto the same sandbox and sees prior effects",
    async () => {
      const h = await stage(WRITE);
      await h.try(READ);
      expect(h.runs.length).toBe(2);
      expect(h.command).toBe(READ);
      expect(h.exitCode).toBe(0);
      expect(h.stdout).toBe("foo\n");
      expect(await h.changes()).toEqual([{ path: file(), kind: "added" }]);
    },
    T,
  );

  test(
    "commit applies the staged write and a later sandbox reads it back",
    async () => {
      const h = await stage(WRITE);
      expect(await h.commit()).toEqual([{ path: file(), kind: "added" }]);
      expect(h.state).toBe("committed");
      expect(existsSync(h.sandbox)).toBe(false);
      expect(readFileSync(file(), "utf8")).toBe("foo\n");
      const r = await stage(READ);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe("foo\n");
    },
    T,
  );

  test(
    "discard undoes the staged write",
    async () => {
      const h = await stage(WRITE);
      const sandbox = h.sandbox;
      await h.discard();
      expect(h.state).toBe("discarded");
      expect(existsSync(sandbox)).toBe(false);
      expect(existsSync(file())).toBe(false);
      const r = await stage(READ);
      expect(r.exitCode).toBe(1);
      await h.discard(); // idempotent
    },
    T,
  );

  test(
    "await using discards the sandbox",
    async () => {
      let sandbox = "";
      {
        await using h = await tryc.create();
        await h.try(WRITE);
        sandbox = h.sandbox;
        expect(existsSync(sandbox)).toBe(true);
      }
      expect(existsSync(sandbox)).toBe(false);
      expect(existsSync(file())).toBe(false);
    },
    T,
  );

  test(
    "merge unions both sandboxes and the last argument wins",
    async () => {
      const base = await stage(WRITE); // file.txt = foo
      const other = await stage('echo "bar" > file.txt'); // file.txt = bar  (conflict)
      const extra = await stage('echo "foo" > other.txt'); // other.txt = foo (union)
      await base.merge(other, extra);
      expect((await base.changes()).map((c) => c.path).sort()).toEqual([file(), file("other.txt")].sort());
      expect(other.state).toBe("open"); // merging does not consume the source
      await base.commit();
      expect(readFileSync(file(), "utf8")).toBe("bar\n");
      expect(readFileSync(file("other.txt"), "utf8")).toBe("foo\n");
    },
    T,
  );

  test(
    "a merged sandbox can still stage commands",
    async () => {
      const base = await stage('echo "foo" > other.txt');
      const other = await stage(WRITE);
      await base.merge(other);
      await base.try(READ);
      expect(base.exitCode).toBe(0);
      expect(base.stdout).toBe("foo\n");
    },
    T,
  );

  test(
    "merge rejects self-merge, spent handles and empty argument lists",
    async () => {
      const a = await stage(WRITE);
      const b = await stage(WRITE);
      await b.discard();
      await expect(a.merge(a)).rejects.toThrow(TryError);
      await expect(a.merge(b)).rejects.toThrow(TryError);
      await expect(a.merge()).rejects.toThrow(TryError);
    },
    T,
  );

  test(
    "a committed handle is spent",
    async () => {
      const h = await stage(WRITE);
      await h.commit();
      await expect(h.changes()).rejects.toThrow(TryError);
      await expect(h.commit()).rejects.toThrow(TryError);
      await expect(h.discard()).rejects.toThrow(TryError);
      await expect(h.try(READ)).rejects.toThrow(TryError);
      await expect(h.instrument(READ)).rejects.toThrow(TryError);
    },
    T,
  );

  traced(
    "instrument records the write and hides SDK internals",
    async () => {
      const h = await stageTraced(WRITE);
      expect(h.traced).toBe(true);
      expect(h.writes()).toContain(file());
      expect(await h.changes()).toEqual([{ path: file(), kind: "added" }]);
      expect(h.writes().some((p) => p.startsWith("/run/try-ts-exit"))).toBe(false);
      expect(h.writes()).not.toContain("/run/try_trace.log");
    },
    T,
  );

  traced(
    "a staged instrumented run adds reads to an untraced handle",
    async () => {
      const h = await stage(WRITE);
      expect(h.traced).toBe(false);
      await h.instrument(READ);
      expect(h.traced).toBe(true);
      expect(h.reads()).toContain(file());
      expect(h.stdout).toBe("foo\n");
      expect(h.runs.length).toBe(2);
    },
    T,
  );

  traced(
    "instrumented runs report the command's exit status, not try's",
    async () => {
      const h = await stageTraced(READ); // file.txt does not exist; `try` itself exits 0 under -t
      expect(h.exitCode).toBe(1);
      expect(h.stderr).toContain("No such file or directory");
    },
    T,
  );

  test(
    "create opens an empty sandbox handle",
    async () => {
      const h = await tryc.create();
      open.push(h);
      expect(h.state).toBe("open");
      expect(h.runs.length).toBe(0);
      expect(existsSync(h.sandbox)).toBe(true);
      expect(await h.changes()).toEqual([]);
      expect(h.traced).toBe(false);
      expect(h.reads()).toEqual([]);
      expect(() => h.command).toThrow(TryError);
      expect(() => h.exitCode).toThrow(TryError);
      expect(() => h.stdout).toThrow(TryError);
      expect(() => h.stderr).toThrow(TryError);
    },
    T,
  );

  test(
    "create(path) pins the sandbox and re-attaches to an existing one",
    async () => {
      const box = join(tmpdir(), `try-ts-pinned-${process.pid}`);
      rmSync(box, { recursive: true, force: true });

      const h = await tryc.create(box);
      open.push(h);
      expect(h.sandbox).toBe(box);
      await h.try(WRITE);
      expect(await h.changes()).toEqual([{ path: file(), kind: "added" }]);

      const again = await tryc.create(box); // same directory: the staged effect is already there
      open.push(again);
      expect(await again.changes()).toEqual([{ path: file(), kind: "added" }]);
      await again.try(READ);
      expect(again.stdout).toBe("foo\n");
    },
    T,
  );
});
