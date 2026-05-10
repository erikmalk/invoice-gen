export interface RunStepOptions {
  onError?: (stepName: string, error: unknown) => Promise<void> | void;
  onComplete?: (stepName: string, durationMs: number) => Promise<void> | void;
}

export async function runStep<T>(
  name: string,
  fn: () => Promise<T>,
  options: RunStepOptions = {},
): Promise<T> {
  const started = performance.now();

  try {
    const result = await fn();
    await options.onComplete?.(name, performance.now() - started);
    return result;
  } catch (error) {
    await options.onError?.(name, error);
    throw error;
  }
}
