const inflight = new Map<string, Promise<void>>();

export async function withScheduleLock<T>(
  scheduleId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = inflight.get(scheduleId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
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
