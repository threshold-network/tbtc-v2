/** Require RPC/ABI data before using it in deployment scripts or test fixtures. */
export function requireValue<T>(
  value: T | null | undefined,
  description: string
): T {
  if (value === null || value === undefined) {
    throw new Error(`${description} is not available`)
  }
  return value
}

export default requireValue
