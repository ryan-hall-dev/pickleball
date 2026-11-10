/**
 * A server-action call's result, or `fallback` when it fails or takes longer
 * than `timeoutMs` (a phone on a dead connection can otherwise hang with no
 * answer). A late answer after the fallback is ignored.
 */
export function settleWithin<Result>(
  call: Promise<Result>,
  timeoutMs: number,
  fallback: Result,
): Promise<Result> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(fallback), timeoutMs);
    call.then(
      (result) => {
        clearTimeout(timeout);
        resolve(result);
      },
      () => {
        clearTimeout(timeout);
        resolve(fallback);
      },
    );
  });
}
