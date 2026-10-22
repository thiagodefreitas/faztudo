import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ApiError, api } from "../../api/client"
import type { Routine } from "../../types"
import { RepeatDialog } from "./repeat-dialog"

const created: Routine = {
  handle: "check-the-build",
  name: "Check the build",
  prompt: "Check the build",
  persona: "coder",
  channel: "general",
  schedule: "0 9 * * 1-5",
  enabled: true,
  source: "app",
}

afterEach(() => vi.restoreAllMocks())

async function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const rootRoute = createRootRoute({
    component: () => <RepeatDialog request="Check the build" persona="coder" channel="general" open onOpenChange={() => {}} />,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([createRoute({ getParentRoute: () => rootRoute, path: "/routines" })]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  })
  await router.load()
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return router
}

describe("RepeatDialog", () => {
  it("is filled in from the run and saves a weekday routine", async () => {
    const user = userEvent.setup()
    const create = vi.spyOn(api, "createRoutine").mockResolvedValue(created)
    await setup()
    expect(await screen.findByLabelText("Request")).toHaveValue("Check the build")
    expect(screen.getByLabelText("Name")).toHaveValue("Check the build")
    expect(screen.getByText("@coder")).toBeInTheDocument()
    expect(screen.getByText("#general")).toBeInTheDocument()
    expect(screen.getByTestId("repeat-next")).toHaveTextContent(/^Next run: .*\(.+\)$/)
    await user.click(screen.getByRole("button", { name: "Create routine" }))
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith({ name: "Check the build", prompt: "Check the build", persona: "coder", channel: "general", schedule: "0 9 * * 1-5" }),
    )
    expect(await screen.findByRole("status")).toHaveTextContent("Created Check the build.")
    expect(screen.getByRole("link", { name: "Open routines" })).toHaveAttribute("href", "/routines")
  })

  it("offers the presets and a custom cron expression", async () => {
    const user = userEvent.setup()
    const create = vi.spyOn(api, "createRoutine").mockResolvedValue(created)
    await setup()
    const select = await screen.findByLabelText("Schedule")
    await user.selectOptions(select, "Every day at 18:00")
    await user.click(screen.getByRole("button", { name: "Create routine" }))
    await waitFor(() => expect(create).toHaveBeenLastCalledWith(expect.objectContaining({ schedule: "0 18 * * *" })))
  })

  it("sends a custom expression and says when it cannot work out the next run", async () => {
    const user = userEvent.setup()
    const create = vi.spyOn(api, "createRoutine").mockResolvedValue(created)
    await setup()
    await user.selectOptions(await screen.findByLabelText("Schedule"), "Custom cron expression")
    const field = screen.getByLabelText("Cron expression")
    await user.clear(field)
    await user.type(field, "*/30 8-17 * * 1-5")
    expect(screen.getByTestId("repeat-next")).toHaveTextContent(/^Next run: /)
    await user.clear(field)
    await user.type(field, "nonsense")
    expect(screen.getByTestId("repeat-next")).toHaveTextContent("Could not work out the next run")
    await user.clear(field)
    await user.type(field, "30 6 * * *")
    await user.click(screen.getByRole("button", { name: "Create routine" }))
    await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({ schedule: "30 6 * * *" })))
  })

  it("shows why the daemon refused", async () => {
    const user = userEvent.setup()
    vi.spyOn(api, "createRoutine").mockRejectedValue(new ApiError(409, "conflict", "routine check-the-build is defined in lanes.toml; pick another name"))
    await setup()
    await user.click(await screen.findByRole("button", { name: "Create routine" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("defined in lanes.toml")
  })

  it("does not save without a request", async () => {
    const user = userEvent.setup()
    const create = vi.spyOn(api, "createRoutine")
    await setup()
    await user.clear(await screen.findByLabelText("Request"))
    expect(screen.getByRole("button", { name: "Create routine" })).toBeDisabled()
    expect(create).not.toHaveBeenCalled()
  })
})
