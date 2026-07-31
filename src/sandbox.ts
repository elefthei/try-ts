import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
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

export async function removeSandbox(dir: string): Promise<void> {
  // `try` mirrors host permissions into the sandbox (`/sys` -> 0555), so parts of the tree can be
  // unwritable; make it writable before unlinking rather than failing the discard.
  await Bun.$`chmod -R u+rwX ${dir}`.nothrow().quiet();
  await rm(dir, { recursive: true, force: true });
}
