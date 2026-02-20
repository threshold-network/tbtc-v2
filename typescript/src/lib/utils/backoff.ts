/**
 * A convenience matcher for withBackoffRetries that retries irrespective of
 * the error.
 *
 * @param error The error to match against. Not necessarily an Error
 *        instance, since the retriable function may throw a non-Error.
 * @returns Always returns true.
 */
export function retryAll(error: any): true {
  return true
}

/**
 * A matcher to specify list of error messages that should abort the retry loop
 * and throw immediately.
 * @param matchers List of patterns for error matching.
 * @returns Matcher function that returns false if error matches one of the patterns.
 *          True is returned if no matches are found and retry loop should continue
 */
export function skipRetryWhenMatched(
  matchers: Array<string | RegExp>
): ErrorMatcherFn {
  return (err: unknown): boolean => {
    if (err instanceof Error) {
      for (const matcher of matchers) {
        if (err.message.match(matcher)) {
          return false
        }
      }
    }
    return true
  }
}

/**
 * @callback ErrorMatcherFn A function that returns true if the passed error
 *           matches and false otherwise. Used to determine if a given error is
 *           eligible for retry in `withBackoffRetries`.
 * @param {Error} error The error to check for eligibility.
 * @return {boolean} True if the error matches, false otherwise.
 */
export type ErrorMatcherFn = (err: unknown) => boolean

/**
 * @callback RetrierFn A function that can retry any function passed to it a
 *           set number of times, returning its result when it succeeds. Created
 *           using `backoffRetrier`.
 * @param {function(): Promise<T>} fn The function to be retried.
 * @return {Promise<T>}
 */
export type RetrierFn<T> = (fn: () => Promise<T>) => Promise<T>

/**
 * A function that is called with execution status messages.
 */
export type ExecutionLoggerFn = (msg: string) => void

/**
 * Returns a retrier that can be passed a function to be retried `retries`
 * number of times, with exponential backoff. The result will return the
 * function's return value if no exceptions are thrown. It will only retry if
 * the function throws an exception matched by `matcher`; {@see retryAll } can
 * be used to retry no matter the exception, though this is not necessarily
 * recommended in production.
 *
 * Example usage:
 *
 *      await url.get("https://example.com/") // may transiently fail
 *      // Retries 3 times with exponential backoff, no matter what error is
 *      // reported by `url.get`.
 *      backoffRetrier(3)(async () => url.get("https://example.com"))
 *      // Retries 3 times with exponential backoff, but only if the error
 *      // message includes "server unavailable".
 *      backoffRetrier(3, (_) => _.message.includes('server unavailable'))(
 *        async () => url.get("https://example.com"))
 *      )
 *
 * @param {number} retries The number of retries to perform before bubbling the
 *        failure out.
 * @param {number} backoffStepMs Initial backoff step in milliseconds that will
 *        be increased exponentially for subsequent retry attempts. (default = 1000 ms)
 * @param {ExecutionLoggerFn} logger A logger function to pass execution messages.
 * @param {ErrorMatcherFn} [errorMatcher=retryAll] A matcher function that
 *        receives the error when an exception is thrown, and returns true if
 *        the error should lead to a retry. A false return will rethrow the
 *        error and terminate the retry loop.
 * @returns {RetrierFn<T>} A function that can retry any function.
 */
export function backoffRetrier<T>(
  retries: number,
  backoffStepMs: number = 1000,
  logger: ExecutionLoggerFn = console.debug,
  errorMatcher: ErrorMatcherFn = skipRetryWhenMatched([
    "Wallet with the given ID has not been registered",
  ])
): RetrierFn<T> {
  return async (fn: () => Promise<T>): Promise<T> => {
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        logger(`making attempt number ${attempt}`)

        return await fn()
      } catch (error: unknown) {
        if (!errorMatcher(error)) {
          // If the matcher doesn't match this error, rethrow and stop.
          throw error
        }

        const backoffMillis = Math.pow(2, attempt) * backoffStepMs
        const jitterMillis = Math.floor(Math.random() * 100)
        const waitMillis = backoffMillis + jitterMillis

        logger(
          `attempt ${attempt} failed: ${error}; ` +
            `retrying after ${waitMillis} milliseconds`
        )

        await new Promise((resolve) => setTimeout(resolve, waitMillis))
      }
    }

    // Last attempt, unguarded.
    return fn()
  }
}
