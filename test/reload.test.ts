import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReloadScheduler } from "../src/editor/reload";

const DEBOUNCE = 250;
const RETRIES = [400, 1000, 2500];

/** A scheduler whose reloads are recorded: one entry per reload, holding its `final` flag. */
function setup(retryDelaysMs: readonly number[] = RETRIES): { scheduler: ReloadScheduler; runs: boolean[] } {
  const runs: boolean[] = [];
  const scheduler = new ReloadScheduler({
    debounceMs: DEBOUNCE,
    retryDelaysMs,
    run: (final) => {
      runs.push(final);
    },
  });
  return { scheduler, runs };
}

const wait = (ms: number): void => {
  vi.advanceTimersByTime(ms);
};

describe("ReloadScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits until the file has been quiet for a while", () => {
    const { scheduler, runs } = setup();
    scheduler.fileChanged();
    wait(DEBOUNCE - 1);
    expect(runs).toEqual([]);
    wait(1);
    expect(runs).toEqual([false]);
  });

  it("reloads once for a burst of changes", () => {
    const { scheduler, runs } = setup();
    for (let event = 0; event < 5; event += 1) {
      scheduler.fileChanged();
      wait(100);
    }
    expect(runs).toEqual([]);
    wait(DEBOUNCE);
    expect(runs).toEqual([false]);
  });

  it("is done after a reload that worked", () => {
    const { scheduler, runs } = setup();
    scheduler.fileChanged();
    wait(DEBOUNCE);
    scheduler.report(true);
    wait(60_000);
    expect(runs).toHaveLength(1);
  });

  it("tries again after a failure, each time later, and marks the last attempt", () => {
    const { scheduler, runs } = setup();
    scheduler.fileChanged();
    wait(DEBOUNCE);
    scheduler.report(false);
    wait(399);
    expect(runs).toHaveLength(1);
    wait(1);
    expect(runs).toHaveLength(2);
    scheduler.report(false);
    wait(1000);
    expect(runs).toHaveLength(3);
    scheduler.report(false);
    wait(2499);
    expect(runs).toHaveLength(3);
    wait(1);
    expect(runs).toEqual([false, false, false, true]);
    scheduler.report(false);
    wait(60_000);
    expect(runs).toHaveLength(4);
  });

  it("stops trying once an attempt works", () => {
    const { scheduler, runs } = setup();
    scheduler.fileChanged();
    wait(DEBOUNCE);
    scheduler.report(false);
    wait(400);
    scheduler.report(true);
    wait(60_000);
    expect(runs).toEqual([false, false]);
  });

  it("starts over when the file changes again between attempts", () => {
    const { scheduler, runs } = setup();
    scheduler.fileChanged();
    wait(DEBOUNCE);
    scheduler.report(false);
    wait(100);
    scheduler.fileChanged();
    wait(DEBOUNCE - 1);
    expect(runs).toHaveLength(1);
    wait(1);
    expect(runs).toHaveLength(2);
    // The new change gets all of its attempts.
    for (const delay of RETRIES) {
      scheduler.report(false);
      wait(delay);
    }
    expect(runs).toEqual([false, false, false, false, true]);
  });

  it("ignores the outcome of a reload that a newer change has replaced", () => {
    const { scheduler, runs } = setup();
    scheduler.fileChanged();
    wait(DEBOUNCE);
    scheduler.fileChanged();
    scheduler.report(false);
    wait(DEBOUNCE);
    expect(runs).toEqual([false, false]);
    scheduler.report(true);
    wait(60_000);
    expect(runs).toHaveLength(2);
  });

  it("ignores an outcome nobody is waiting for", () => {
    const { scheduler, runs } = setup();
    scheduler.report(false);
    wait(60_000);
    expect(runs).toEqual([]);

    scheduler.fileChanged();
    wait(DEBOUNCE);
    scheduler.report(false);
    scheduler.report(false); // reported twice: counts once
    wait(400);
    expect(runs).toHaveLength(2);
    wait(60_000);
    expect(runs).toHaveLength(2);
  });

  it("can be cancelled before a reload and while one is running", () => {
    const { scheduler, runs } = setup();
    scheduler.fileChanged();
    scheduler.cancel();
    wait(60_000);
    expect(runs).toEqual([]);

    scheduler.fileChanged();
    wait(DEBOUNCE);
    scheduler.cancel();
    scheduler.report(false);
    wait(60_000);
    expect(runs).toHaveLength(1);
  });

  it("forgets earlier failures when it is cancelled", () => {
    const { scheduler, runs } = setup();
    scheduler.fileChanged();
    wait(DEBOUNCE);
    for (const delay of RETRIES) {
      scheduler.report(false);
      wait(delay);
    }
    expect(runs.at(-1)).toBe(true);
    scheduler.cancel();
    scheduler.fileChanged();
    wait(DEBOUNCE);
    expect(runs.at(-1)).toBe(false);
  });

  it("makes the first attempt the last one when there is nothing to retry with", () => {
    const { scheduler, runs } = setup([]);
    scheduler.fileChanged();
    wait(DEBOUNCE);
    expect(runs).toEqual([true]);
    scheduler.report(false);
    wait(60_000);
    expect(runs).toEqual([true]);
  });
});
