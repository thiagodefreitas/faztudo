const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

export function isUlid(value: string): boolean {
  return value.length === 26 && [...value].every((char) => ALPHABET.includes(char))
}

export function ulid(time = Date.now()): string {
  let stamp = time
  let timePart = ""
  for (let i = 0; i < 10; i += 1) {
    timePart = ALPHABET[stamp % 32] + timePart
    stamp = Math.floor(stamp / 32)
  }
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  let randomPart = ""
  for (const byte of bytes) randomPart += ALPHABET[byte % 32]
  return timePart + randomPart
}
