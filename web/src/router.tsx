import { QueryClient } from "@tanstack/react-query"
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  lazyRouteComponent,
  redirect,
} from "@tanstack/react-router"
import { ApiError, api } from "./api/client"
import { DevicesPage, LoginPage, PairPage } from "./components/auth"
import { ChannelPage } from "./components/channel"
import { InboxPage } from "./components/inbox"
import { LanesPage } from "./components/lanes"
import { OrganizationPage } from "./components/organization"
import { RoutinesPage } from "./components/routines/routines"
import { Shell } from "./components/shell"
import { qk } from "./state/keys"
import { queryClient } from "./state/query-client"
import { sortMessages } from "./state/reduce"

export interface RouterContext {
  queryClient: QueryClient
}

export interface ChannelSearch {
  run?: string
  thread?: string
  /** A message to scroll to, set by search results. */
  m?: string
  view?: "diff"
}

function validateSearch(search: Record<string, unknown>): ChannelSearch {
  const result: ChannelSearch = {}
  if (typeof search.run === "string" && search.run) result.run = search.run
  if (typeof search.thread === "string" && search.thread) result.thread = search.thread
  if (typeof search.m === "string" && search.m) result.m = search.m
  if (search.view === "diff") result.view = "diff"
  return result
}

async function withAuthRedirect<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      throw redirect({ to: "/login", replace: true })
    }
    throw error
  }
}

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: Shell,
})

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  component: () => <LoginPage />,
})

const pairRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/pair",
  component: () => <PairPage />,
})

const devicesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/devices",
  loader: ({ context }) =>
    withAuthRedirect(() =>
      Promise.all([
        context.queryClient.ensureQueryData({ queryKey: qk.devices, queryFn: () => api.devices() }),
        context.queryClient.ensureQueryData({ queryKey: qk.caInfo, queryFn: () => api.caInfo() }),
      ]),
    ),
  component: DevicesPage,
})

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  loader: ({ context }) =>
    withAuthRedirect(() =>
      Promise.all([
        context.queryClient.ensureQueryData({ queryKey: qk.me, queryFn: () => api.me() }),
        context.queryClient.ensureQueryData({ queryKey: qk.members, queryFn: () => api.members() }),
        context.queryClient.ensureQueryData({ queryKey: qk.channels, queryFn: () => api.channels() }),
      ]),
    ),
  component: InboxPage,
})

const channelRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/c/$channelId",
  validateSearch,
  loader: ({ context, params }) =>
    withAuthRedirect(() =>
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
    ),
  component: ChannelPage,
})

const lanesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/lanes",
  loader: ({ context }) =>
    withAuthRedirect(() =>
      context.queryClient.ensureQueryData({
        queryKey: qk.lanes,
        queryFn: () => api.lanes(),
      }),
    ),
  component: LanesPage,
})

const officeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/office",
  loader: ({ context }) =>
    withAuthRedirect(() =>
      Promise.all([
        context.queryClient.ensureQueryData({ queryKey: qk.me, queryFn: () => api.me() }),
        context.queryClient.ensureQueryData({ queryKey: qk.members, queryFn: () => api.members() }),
        context.queryClient.ensureQueryData({ queryKey: qk.channels, queryFn: () => api.channels() }),
        context.queryClient.ensureQueryData({ queryKey: qk.lanes, queryFn: () => api.lanes() }),
        context.queryClient.ensureQueryData({ queryKey: qk.runs, queryFn: () => api.runs() }),
        context.queryClient.ensureQueryData({ queryKey: qk.approvals, queryFn: () => api.approvals() }),
      ]),
    ),
  component: lazyRouteComponent(() => import("./components/office/scene"), "OfficePage"),
})

const organizationRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/organization",
  loader: ({ context }) =>
    withAuthRedirect(() =>
      Promise.all([
        context.queryClient.ensureQueryData({ queryKey: qk.me, queryFn: () => api.me() }),
        context.queryClient.ensureQueryData({ queryKey: qk.members, queryFn: () => api.members() }),
        context.queryClient.ensureQueryData({ queryKey: qk.org, queryFn: () => api.org() }),
        context.queryClient.ensureQueryData({ queryKey: qk.lanes, queryFn: () => api.lanes() }),
        context.queryClient.ensureQueryData({ queryKey: qk.runs, queryFn: () => api.runs() }),
        context.queryClient.ensureQueryData({ queryKey: qk.approvals, queryFn: () => api.approvals() }),
      ]),
    ),
  component: OrganizationPage,
})

const routinesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/routines",
  loader: ({ context }) =>
    withAuthRedirect(() =>
      Promise.all([
        context.queryClient.ensureQueryData({ queryKey: qk.me, queryFn: () => api.me() }),
        context.queryClient.ensureQueryData({ queryKey: qk.members, queryFn: () => api.members() }),
        context.queryClient.ensureQueryData({ queryKey: qk.routines, queryFn: () => api.routines() }),
      ]),
    ),
  component: RoutinesPage,
})

const routeTree = rootRoute.addChildren([
  indexRoute,
  loginRoute,
  pairRoute,
  devicesRoute,
  channelRoute,
  lanesRoute,
  officeRoute,
  organizationRoute,
  routinesRoute,
])

export const router = createRouter({
  routeTree,
  context: { queryClient },
})

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router
  }
}

