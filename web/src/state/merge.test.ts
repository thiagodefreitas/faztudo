import { describe, expect, it } from "vitest"
import type { Approval, Lane } from "../types"
import { mergeApprovals, mergeLanes } from "./merge"

const base: Approval = {
  id: "a1", channel_id: "c1", requested_by: "m1", run_id: "r1",
  title: "Merge change", detail: "", options: [], state: "pending",
}

describe("mergeApprovals", () => {
  it("lets the fetched resolved approval win over a stale pending one", () => {
    const merged = mergeApprovals([{ ...base, state: "resolved" }], [base])
    expect(merged).toHaveLength(1)
    expect(merged[0]?.state).toBe("resolved")
  })
  it("keeps a locally resolved approval when the fetch is older", () => {
    expect(mergeApprovals([base], [{ ...base, state: "resolved" }])[0]?.state).toBe("resolved")
  })
  it("keeps an approval the stream added that the fetch has not seen", () => {
    expect(mergeApprovals([], [base])).toHaveLength(1)
  })
})

describe("mergeLanes", () => {
  it("drops lanes the API no longer returns", () => {
    const lane = { id: "agy/default" } as Lane
    expect(mergeLanes([], [lane])).toEqual([])
  })
  it("prefers the newer local reading of a listed lane", () => {
    const server = { id: "a", running: 0 } as Lane
    expect(mergeLanes([server], [{ ...server, running: 2 }])[0]?.running).toBe(2)
  })
})
