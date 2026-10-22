import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const css = readFileSync("src/index.css", "utf8")

function token(block: string, name: string): string {
  const match = new RegExp(`--color-${name}:\\s*(#[0-9a-f]{6})`, "i").exec(block)
  if (!match) throw new Error(`missing --color-${name}`)
  return match[1]!
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((start) => {
    const channel = parseInt(hex.slice(start, start + 2), 16) / 255
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function ratio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

const light = css.slice(css.indexOf("@theme"), css.indexOf("html.dark"))
const dark = css.slice(css.indexOf("html.dark"), css.indexOf("@layer base"))

describe("small text on the accent tint", () => {
  it("reaches 4.5:1 in both themes with the accent-text token", () => {
    expect(ratio(token(light, "accent-text"), token(light, "accent-soft"))).toBeGreaterThanOrEqual(4.5)
    expect(ratio(token(dark, "accent-text"), token(dark, "accent-soft"))).toBeGreaterThanOrEqual(4.5)
  })

  it("shows why the plain accent is not enough in the light theme", () => {
    expect(ratio(token(light, "accent"), token(light, "accent-soft"))).toBeLessThan(4.5)
  })

  it("applies the darker token wherever text-accent sits on bg-accent-soft", () => {
    expect(css).toMatch(/\.bg-accent-soft\.text-accent\s*\{\s*color:\s*var\(--color-accent-text\)/)
  })
})
