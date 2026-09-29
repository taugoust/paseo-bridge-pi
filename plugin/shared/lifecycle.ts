export function mayApplyAsyncResult<T>(input: {
  stopped: boolean;
  aborted: boolean;
  sequence: number;
  currentSequence: number;
  current: T | undefined;
  expected: T;
}): boolean {
  return !input.stopped && !input.aborted && input.sequence === input.currentSequence && input.current === input.expected;
}
