/**
 * Fetches a pinned copy of the `try` tool (github.com/binpash/try) into `vendor/`.
 *
 * The `-t TRACE_FILE` flag that instrumented runs depend on exists only on upstream
 * `main`, not in the v0.2.0 release, so we pin an exact revision rather than a tag.
 *
 * Standalone by design: it must run before `src/` exists, so it depends on nothing local.
 */
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const TRY_REF = "f2efe7d0c2f05bc30c72652833e89b472152cacf";

const VENDOR_DIR = join(import.meta.dir, "..", "vendor");

const FILES: { source: string; dest: string; mode: number }[] = [
  { source: "try", dest: "try", mode: 0o755 },
  { source: "utils/try-parse-trace", dest: "try-parse-trace", mode: 0o755 },
  { source: "LICENSE", dest: "LICENSE", mode: 0o644 },
];

async function fetchFile(source: string): Promise<ArrayBuffer> {
  const url = `https://raw.githubusercontent.com/binpash/try/${TRY_REF}/${source}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`failed to fetch ${url}: HTTP ${res.status} ${res.statusText}`);
  return await res.arrayBuffer();
}

export async function vendor(): Promise<void> {
  await mkdir(VENDOR_DIR, { recursive: true });

  for (const { source, dest, mode } of FILES) {
    const bytes = await fetchFile(source);
    const path = join(VENDOR_DIR, dest);
    await Bun.write(path, bytes);
    await chmod(path, mode);
    console.log(`vendored ${path} (${bytes.byteLength} bytes)`);
  }

  await writeFile(join(VENDOR_DIR, "REF"), `${TRY_REF}\n`);
}

if (import.meta.main) {
  await vendor();
}
