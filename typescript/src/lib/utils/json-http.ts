/** The response information needed by the relayer callers. */
export interface JsonResponse<T> {
  status: number
  data: T
}

/** HTTP errors retain status and response data for conflict/retry handling. */
export class JsonHttpError extends Error {
  readonly isJsonHttpError = true

  constructor(
    message: string,
    readonly code: string,
    readonly response?: JsonResponse<unknown>
  ) {
    super(message)
    this.name = "JsonHttpError"
  }
}

/**
 * Posts JSON using the platform transport, with a deadline covering the entire
 * response body. Redirects fail closed: a relayer must not forward a deposit
 * request to a different endpoint or silently change its method to GET.
 * @param url - The configured HTTP(S) endpoint.
 * @param payload - The JSON request body.
 * @param options - Request timeout and decoded response size limit.
 * @returns The status and parsed JSON response.
 */
export async function postJson<T = unknown>(
  url: string,
  payload: unknown,
  options: { timeout?: number; maxResponseBytes?: number } = {}
): Promise<JsonResponse<T>> {
  const { timeout = 90000, maxResponseBytes = 1024 * 1024 } = options
  const endpoint = new URL(url)
  if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
    throw new Error("JSON requests require an HTTP(S) endpoint")
  }
  if (!(timeout > 0) || !(maxResponseBytes > 0)) {
    throw new Error("JSON request limits must be positive")
  }

  const body = JSON.stringify(payload)
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeout)

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: controller.signal,
      redirect: "error",
    })

    // Count streamed bytes, not only Content-Length: peers can omit that header,
    // and fetch transparently decompresses responses before returning chunks.
    const reader = response.body?.getReader()
    let size = 0
    let text = ""
    const decoder = new TextDecoder()
    if (reader) {
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          size += value.byteLength
          if (size > maxResponseBytes) {
            controller.abort()
            throw new JsonHttpError(
              "JSON response exceeds the size limit",
              "ERR_RESPONSE_TOO_LARGE"
            )
          }
          text += decoder.decode(value, { stream: true })
        }
        text += decoder.decode()
      } finally {
        reader.releaseLock()
      }
    }

    let data: unknown = text
    if (text.length) {
      try {
        data = JSON.parse(text)
      } catch {
        if (response.ok) {
          throw new JsonHttpError("Invalid JSON response", "ERR_BAD_RESPONSE", {
            status: response.status,
            data: text,
          })
        }
      }
    }

    if (!response.ok) {
      throw new JsonHttpError(
        `Request failed with status code ${response.status}`,
        "ERR_HTTP_RESPONSE",
        { status: response.status, data }
      )
    }
    return { status: response.status, data: data as T }
  } catch (error) {
    if (error instanceof JsonHttpError) throw error
    if (timedOut) {
      throw new JsonHttpError("Request timed out", "ECONNABORTED")
    }
    const failure = error as Error & { cause?: { code?: string } }
    const code = failure.cause?.code
    throw new JsonHttpError(
      failure.message || "Network request failed",
      code === "UND_ERR_CONNECT_TIMEOUT"
        ? "ECONNABORTED"
        : code || "ERR_NETWORK"
    )
  } finally {
    clearTimeout(timer)
  }
}
