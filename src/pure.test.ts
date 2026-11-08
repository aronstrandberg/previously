import { expect, test } from "bun:test"
import { splitText } from "./extract.ts"
import { ftsQuery } from "./search.ts"
import { parseTime } from "./time.ts"

test("ftsQuery keeps quoted phrases and neutralizes FTS5 operators in free text", () => {
  expect(ftsQuery('fix "connection reset" AND NOT foo*')).toBe('"connection reset" OR "fix" OR "and" OR "not" OR "foo"')
  expect(ftsQuery("  ")).toBe("")
})

test("splitText covers long text with overlapping chunks no longer than the window", () => {
  const text = Array.from({ length: 400 }, (_, i) => `Sentence number ${i} is here.`).join(" ")
  const chunks = splitText(text)
  expect(chunks.length).toBeGreaterThan(1)
  for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(1500)
  expect(chunks.at(-1)!.endsWith("Sentence number 399 is here.")).toBe(true)
})

test("parseTime reads durations relative to now and rejects garbage", () => {
  expect(parseTime("2h", 10_000_000)).toBe(10_000_000 - 7_200_000)
  expect(parseTime("2026-11-01T00:00:00Z")).toBe(Date.UTC(2026, 10, 1))
  expect(() => parseTime("yesterday-ish")).toThrow()
})
