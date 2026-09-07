/** stend_sk_9f2c41ab… -> stend_sk_9f2c••••••ab41 */
export function maskKey(key: string): string {
  if (key.length < 20) return '••••'
  const prefixEnd = key.lastIndexOf('_') + 1
  return `${key.slice(0, prefixEnd + 4)}••••••${key.slice(-4)}`
}
