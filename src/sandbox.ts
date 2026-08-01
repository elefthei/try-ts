import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { TryError } from "./errors.ts";

export async function createSandbox(root: string): Promise<string> {
  const dir = await mkdtemp(join(root, "try-ts-"));
  // Sandbox paths are joined with ':' into `try -L` lists, which have no escaping.
  if (dir.includes(":")) {
    await rm(dir, { recursive: true, force: true });
    throw new TryError(`sandbox path must not contain ':': ${dir}`);
  }
  return dir;
}

/** Prepares a caller-supplied sandbox directory: created if missing, reused if it already holds one. */
export async function openSandbox(path: string): Promise<string> {
  const dir = resolve(path);
  // Sandbox paths are joined with ':' into `try -L` lists, which have no escaping.
  if (dir.includes(":")) throw new TryError(`sandbox path must not contain ':': ${dir}`);

  const stats = await stat(dir).catch(() => undefined);
  if (stats && !stats.isDirectory()) throw new TryError(`sandbox path is not a directory: ${dir}`);

  // `try -N DIR` exits 2 with `could not find sandbox directory` when the directory is missing.
  await mkdir(dir, { recursive: true });
  return dir;
}

export async function removeSandbox(dir: string): Promise<void> {
  // `try` mirrors host permissions into the sandbox (`/sys` -> 0555), so parts of the tree can be
  // unwritable; make it writable before unlinking rather than failing the discard.
  await Bun.$`chmod -R u+rwX ${dir}`.nothrow().quiet();
  await rm(dir, { recursive: true, force: true });
}
