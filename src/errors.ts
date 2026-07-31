/** Every failure this SDK raises. A non-zero *command* exit is not a failure — see `TryHandle.exitCode`. */
export class TryError extends Error {
  constructor(
    message: string,
    readonly detail?: { exitCode?: number; stderr?: string; command?: string },
  ) {
    super(message);
    this.name = "TryError";
  }
}
