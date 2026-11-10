/**
 * Decides when to re-read a file that changed on disk.
 *
 * A burst of change events (a generator rewriting the file, an editor saving in several steps)
 * is collapsed into one reload. A reload that fails is tried again a few times, because the
 * events often arrive while the file is still being written and is not yet a complete archive.
 */
export interface ReloadSchedulerOptions {
  /** Quiet time after the last change event before the file is read. */
  readonly debounceMs: number;
  /** Delay before each further attempt once a reload has failed. */
  readonly retryDelaysMs: readonly number[];
  /** Starts a reload. `final` is false while another attempt will follow a failure. */
  readonly run: (final: boolean) => void;
}

export class ReloadScheduler {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private attempt = 0;
  private awaitingResult = false;

  constructor(private readonly options: ReloadSchedulerOptions) {}

  /** The file changed: start over, after the debounce delay. */
  fileChanged(): void {
    this.attempt = 0;
    this.schedule(this.options.debounceMs);
  }

  /** Reports the outcome of the reload started by the last `run` call. */
  report(succeeded: boolean): void {
    if (!this.awaitingResult) return;
    this.awaitingResult = false;
    if (succeeded) return;
    const delay = this.options.retryDelaysMs[this.attempt];
    if (delay === undefined) return;
    this.attempt += 1;
    this.schedule(delay);
  }

  /** Drops a pending reload and stops waiting for a running one. */
  cancel(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.awaitingResult = false;
    this.attempt = 0;
  }

  private schedule(delayMs: number): void {
    clearTimeout(this.timer);
    this.awaitingResult = false;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.awaitingResult = true;
      this.options.run(this.attempt >= this.options.retryDelaysMs.length);
    }, delayMs);
  }
}
