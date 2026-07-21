/**
 * Serializes one process-wide IM connection across login, logout, account
 * replacement, and app quit. Keeping start/stop on one queue prevents a late
 * async start from bringing transports back online after logout has begun.
 */
export interface SerializedConnectionLifecycle {
  start(): void;
  stop(): Promise<void>;
  isStarted(): boolean;
}

/** Dependencies are injected so lifecycle ordering stays unit-testable. */
export interface SerializedConnectionLifecycleDeps {
  startConnection(): Promise<void>;
  stopConnection(): Promise<void>;
  onStartError(error: unknown): void;
}

/** Create an idempotent, restartable connection lifecycle. */
export function createSerializedConnectionLifecycle(
  deps: SerializedConnectionLifecycleDeps,
): SerializedConnectionLifecycle {
  let started = false;
  let needsStop = false;
  let generation = 0;
  let tail = Promise.resolve();

  const enqueue = (operation: () => Promise<void>): Promise<void> => {
    const current = tail.catch(() => undefined).then(operation);
    // A failed operation must not poison later logout/relogin operations.
    tail = current.catch(() => undefined);
    return current;
  };

  return {
    start(): void {
      if (started) return;
      started = true;
      // Keep this set even if start fails: a partially initialized transport
      // still needs an explicit stop before its account resources are closed.
      needsStop = true;
      const requestedGeneration = ++generation;
      const operation = enqueue(async () => {
        // A stop requested before this queued start ran invalidates it.
        if (!started || generation !== requestedGeneration) return;
        await deps.startConnection();
      });
      void operation.catch((error) => {
        if (generation === requestedGeneration) started = false;
        deps.onStartError(error);
      });
    },

    async stop(): Promise<void> {
      const shouldStopConnection = needsStop;
      started = false;
      needsStop = false;
      generation += 1;
      await enqueue(async () => {
        if (!shouldStopConnection) return;
        await deps.stopConnection();
      });
    },

    isStarted(): boolean {
      return started;
    },
  };
}
