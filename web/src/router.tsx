import { QueryClient } from "@tanstack/react-query"
import { createRootRouteWithContext, createRoute, createRouter, redirect } from "@tanstack/react-router"
import { api } from "./api/client"
import { ChannelPage } from "./components/channel"
import { Shell } from "./components/shell"
import { qk } from "./state/keys"
import { queryClient } from "./state/query-client"
import { sortMessages } from "./state/reduce"

export interface RouterContext {
  queryClient: QueryClient
}

export interface ChannelSearch {
  run?: string
  view?: "diff"
}

function validateSearch(search: Record<string, unknown>): ChannelSearch {
  const result: ChannelSearch = {}
  if (typeof search.run === "string" && search.run) result.run = search.run
  if (search.view === "diff") result.view = "diff"
  return result
}

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: Shell,
})

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  loader: async ({ context }) => {
    const channels = await context.queryClient.ensureQueryData({
      queryKey: qk.channels,
      queryFn: () => api.channels(),
    })
    const first = channels[0]
    if (!first) return
    throw redirect({
      to: "/c/$channelId",
      params: { channelId: first.id },
      replace: true,
    })
  },
  component: HomePage,
})

const channelRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/c/$channelId",
  validateSearch,
  loader: ({ context, params }) =>
    Promise.all([
      context.queryClient.ensureQueryData({ queryKey: qk.me, queryFn: () => api.me() }),
      context.queryClient.ensureQueryData({ queryKey: qk.members, queryFn: () => api.members() }),
      context.queryClient.ensureQueryData({ queryKey: qk.channels, queryFn: () => api.channels() }),
      context.queryClient.ensureQueryData({ queryKey: qk.lanes, queryFn: () => api.lanes() }),
      context.queryClient.ensureQueryData({ queryKey: qk.runs, queryFn: () => api.runs() }),
      context.queryClient.ensureQueryData({ queryKey: qk.approvals, queryFn: () => api.approvals() }),
      context.queryClient.ensureQueryData({
        queryKey: qk.messages(params.channelId),
        queryFn: async () => sortMessages(await api.messages(params.channelId, { limit: 100 })),
      }),
    ]),
  component: ChannelPage,
})

function HomePage() {
  return <p className="p-6 text-[14px] text-muted">No channels yet.</p>
}

const routeTree = rootRoute.addChildren([indexRoute, channelRoute])

export const router = createRouter({
  routeTree,
  context: { queryClient },
})

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router
  }
}
