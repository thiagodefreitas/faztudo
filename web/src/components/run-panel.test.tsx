import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import { api } from "../api/client"
import { qk } from "../state/keys"
import type { RunPrompt } from "../types"
import { RunPanel } from "./run-panel"

describe("RunPanel context tab", () => {
  it("retries a diff that was not ready", async () => {
    const user = userEvent.setup()
    const fetchDiff = vi.spyOn(api, "diff").mockRejectedValueOnce(new Error("Not ready")).mockResolvedValue({ diff: "+ready" })
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
    client.setQueryData(qk.runs, [])
    client.setQueryData(qk.output("run"), [])
    const root = createRootRoute({ component: () => <RunPanel channelId="channel" runId="run" view="diff" /> })
    const router = createRouter({ routeTree: root.addChildren([]), history: createMemoryHistory({ initialEntries: ["/"] }), context: {} })
    await router.load()
    render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>)
    await user.click(await screen.findByRole("button", { name: "Retry" }))
    await waitFor(() => expect(fetchDiff).toHaveBeenCalledTimes(2))
    expect(await screen.findByText("+ready")).toBeInTheDocument()
    fetchDiff.mockRestore()
  })

  it("shows stored prompt sections when Context is selected", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
    const request = "\nRequest:\nCheck context"
    const payload: RunPrompt = {
      run_id: "run",
      prompt: request,
      sections: [{ name: "request", bytes: request.length, spans: [{ offset: 0, bytes: request.length }] }],
    }
    client.setQueryData(qk.runs, [])
    client.setQueryData(qk.output("run"), [])
    client.setQueryData(qk.prompt("run"), payload)
    const root = createRootRoute({ component: () => <RunPanel channelId="channel" runId="run" view="context" /> })
    const router = createRouter({ routeTree: root.addChildren([]), history: createMemoryHistory({ initialEntries: ["/"] }), context: {} })
    await router.load()
    render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>)
    expect(screen.getByRole("button", { name: "Context" })).toHaveAttribute("aria-pressed", "true")
    expect(screen.getByText("Request, 23 B")).toBeInTheDocument()
  })
})
