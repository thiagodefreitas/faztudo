import { QueryClientProvider } from "@tanstack/react-query"
import { RouterProvider } from "@tanstack/react-router"
import * as Tooltip from "@radix-ui/react-tooltip"
import { router } from "./router"
import { queryClient } from "./state/query-client"

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <Tooltip.Provider delayDuration={300}>
        <RouterProvider router={router} />
      </Tooltip.Provider>
    </QueryClientProvider>
  )
}
