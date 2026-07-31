export interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface SpawnOptions {
  cwd: string;
  env: Record<string, string>;
  /** Tee the child's output to this process's stdout/stderr while still capturing it. */
  stream?: boolean;
}

/**
 * Runs `try` with an exact argv.
 *
 * `Bun.spawn` rather than Bun Shell: the caller's command string must reach `try` as one
 * argument, unmangled by a second shell, and both streams must be captured rather than inherited.
 */
export async function runTry(argv: string[], { cwd, env, stream }: SpawnOptions): Promise<SpawnResult> {
  // `stderr` defaults to "inherit"; stdin is left closed so nothing blocks on a terminal read.
  const proc = Bun.spawn({ cmd: argv, cwd, env, stdout: "pipe", stderr: "pipe" });

  const drain = async (readable: ReadableStream<Uint8Array>, sink?: NodeJS.WriteStream) => {
    const decoder = new TextDecoder();
    let text = "";
    for await (const chunk of readable) {
      const decoded = decoder.decode(chunk, { stream: true });
      text += decoded;
      sink?.write(decoded);
    }
    return text + decoder.decode();
  };

  const [stdout, stderr] = await Promise.all([
    drain(proc.stdout, stream ? process.stdout : undefined),
    drain(proc.stderr, stream ? process.stderr : undefined),
  ]);

  return { exitCode: await proc.exited, stdout, stderr };
}
