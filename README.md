# try-ts

A Bun/TypeScript SDK for speculative shell execution, wrapping [`try`](https://github.com/binpash/try).

Run a command, look at what it *would* do to the filesystem, stage more commands on top, merge
sandboxes — then either apply the whole thing or throw it away. Nothing touches the real
filesystem until `commit()`.

```ts
import { TryConsole } from "try-ts";

const tryc = new TryConsole(process.cwd());

const h = await tryc.try('echo "foo" > file.txt');
await h.changes();          // [{ path: "/…/file.txt", kind: "added" }] — nothing on disk yet
await h.try("cat file.txt"); // stages onto the SAME sandbox; sees the write above
h.stdout;                    // "foo\n"

await h.commit();            // apply to the real filesystem  (or)
await h.discard();           // drop the overlay; disk was never touched
```

## Install

```sh
bun install
bun run vendor    # fetches the pinned `try` + `try-parse-trace` into vendor/
```

`try` is resolved in this order: `TryConsoleOptions.tryBin` → `$TRY_BIN` → `vendor/try` →
`try` on `PATH`. The vendored copy is pinned to an exact upstream revision (`vendor/REF`) because
the `-t TRACE_FILE` flag instrumented runs need is not in the v0.2.0 release.

## API

### `new TryConsole(path, env?, options?)`

`path` is the working directory commands run in. `env` is merged over `process.env` (never
replaces it — `try` itself shells out to `mktemp`, `find`, `getfattr` and `unshare`).

| option | default | meaning |
| --- | --- | --- |
| `tryBin` | resolved | path to the `try` executable |
| `shell` | `/bin/sh` | `TRY_SHELL`; traced and untraced runs use the same shell |
| `sandboxRoot` | `os.tmpdir()` | where sandboxes are created |
| `include` / `exclude` | `[]` | `-I` / `-E` patterns: unanchored regexes over host paths |
| `network` | `true` | `false` runs with `-x` |
| `unionHelper` | – | `-U PATH` (mergerfs/unionfs) for hosts where overlay mounts fail |
| `stream` | `false` | tee child output to this process's stdout/stderr |

* `tryc.try(cmd, opts?)` → `Promise<TryHandle>` — fresh sandbox.
* `tryc.instrument(cmd, opts?)` → `Promise<TryHandle>` — same, traced with `strace`.

### `TryHandle`

| member | meaning |
| --- | --- |
| `sandbox` | the sandbox directory |
| `state` | `"open" \| "committed" \| "discarded"` |
| `runs` | every run staged here, oldest first |
| `command` / `exitCode` / `stdout` / `stderr` | the **most recent** run |
| `traced` | whether any run was instrumented |
| `try(cmd, opts?)` | stage another command on this sandbox |
| `instrument(cmd, opts?)` | same, traced |
| `merge(...others)` | fold other sandboxes' effects into this one |
| `changes()` | cumulative effects across every run and merge |
| `reads()` / `writes()` / `trace()` | syscall-level view of the traced runs |
| `commit()` | apply the effects, return what was applied, spend the handle |
| `discard()` | drop the overlay (idempotent); this *is* the undo |
| `[Symbol.asyncDispose]` | `await using h = await tryc.try(…)` discards on scope exit |

`exitCode` is always the *command's* status, recovered through a sandbox-local sentinel file:
`try -t` overwrites its own exit status, and `try` also exits non-zero for its own setup failures.
A non-zero command status is not an error; a `try` failure is a `TryError`.

`merge(a, b)` resolves conflicts `b` > `a` > `this` — `Object.assign` order. Sources are left open
and keep their own runs and traces; discard them yourself. Because upstream's merge ignores copy
failures, the SDK re-reads the summary afterwards and throws if an effect was dropped.

## Host requirements

Linux with unprivileged user namespaces and `overlay` in `/proc/filesystems`, plus `unshare`,
`mount`, `mktemp`, `getfattr`/`setfattr`. Instrumented runs additionally need `strace` and
`python3`.

**Nested mounts break overlays.** `try` overlays each root-level directory separately, and the
kernel refuses to clone a lowerdir that has locked child mounts. On WSL, docker hosts and systemd
machines something is usually mounted *inside* `/usr` (`/usr/lib/wsl/lib`), `/var`
(`/var/lib/docker`), `/tmp` (`/tmp/.X11-unix`) or `/run`, so those overlays fail, `try` warns on
stderr, and the sandbox ends up with no `/usr` — i.e. no binaries. Symptom:

```
try(…): Warning: Failed mounting /usr as an overlay and mergerfs or unionfs not set …
unshare: failed to execute /bin/sh: No such file or directory
```

Two ways out:

* `scripts/private-mounts.sh CMD…` runs `CMD` in a private mount namespace with the nested mounts
  lazily detached (the host's own mount table is untouched) and privileges dropped back to you. The
  integration suite runs this way: `bun run test:integration:ns`.
* Install `mergerfs` or `unionfs-fuse` and pass `unionHelper`; `try` then unions the nested mounts
  into a plain directory and overlays that.

## Development

```sh
bun run lint                   # biome: lint + format check + import order
bun run lint:fix               # …applying the safe fixes
bun run typecheck              # tsc --noEmit
bun test                       # parser suites; integration tests skip
bun run test:integration       # add real sandboxes (needs a host that can overlay)
bun run test:integration:ns    # …in a prepared private mount namespace (needs sudo)
```

GitHub Actions runs the same commands: `.github/workflows/ci.yml` (lint, typecheck, unit tests,
then the integration suite through `scripts/private-mounts.sh`) and `.github/workflows/codeql.yml`
(CodeQL `security-and-quality` over TypeScript and the workflows themselves).

## Limitations

* **Effects are captured filesystem-wide**, not scoped to `path`: a command writing outside the
  working directory still shows up in `changes()` and still gets committed. Scope deliberately with
  `include`.
* Sandboxes live under `os.tmpdir()`, which is often tmpfs — a command writing gigabytes writes to
  RAM. Pass `sandboxRoot` on a disk-backed filesystem for large workloads.
* Filenames containing newlines break `try`'s own line-oriented summary and commit loops;
  `parseSummary` throws rather than silently under-report.
* Merging a sandbox that *deletes* a file requires recreating an overlay whiteout by copy, which an
  unprivileged process cannot always do. The SDK detects the loss and throws `merge lost effects:
  …`; commit that sandbox on its own instead.
* `include`/`exclude` are per-console, not per-run: they define what a sandbox will commit, so a
  single run may not diverge from it.

## Licence

MIT (see `LICENSE`). `vendor/` holds an unmodified pinned copy of `binpash/try`, MIT licensed —
see `vendor/LICENSE`.
