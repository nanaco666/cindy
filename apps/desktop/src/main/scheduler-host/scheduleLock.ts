const inflight = new Map<string, Promise<void>>();

export async function withScheduleLock<T>(
  scheduleId: string,
  signal: AbortSignal,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = inflight.get(scheduleId) ?? Promise.resolve();
  // Scheduler registers a run before it waits for this per-schedule lock.  A
  // delete/pause can therefore abort a run while it is waiting here; do not
  // let that stale callback create a session after it acquires the lock.
  const runWhenNotAborted = async (): Promise<T> => {
    if (signal.aborted) {
      throw new Error('schedule execution aborted before acquiring schedule lock');
    }
    return fn();
  };
  const next = prev.then(runWhenNotAborted, runWhenNotAborted);
  const marker = next.then(
    () => undefined,
    () => undefined,
  );
  inflight.set(scheduleId, marker);
  try {
    return await next;
  } finally {
    if (inflight.get(scheduleId) === marker) {
      inflight.delete(scheduleId);
    }
  }
}
