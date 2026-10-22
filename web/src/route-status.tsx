import type { ErrorComponentProps } from "@tanstack/react-router"

export function isChunkLoadError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Loading chunk .* failed|ChunkLoadError/i.test(error.message)
}

export function RoutePending() {
  return <div role="progressbar" aria-label="Loading page" className="fixed inset-x-0 top-0 z-50 h-0.5 bg-accent" />
}

export function RouteError({ error, reset }: ErrorComponentProps) {
  const chunkFailed = isChunkLoadError(error)
  return (
    <main role="alert" className="m-auto max-w-md p-6 text-ink">
      <h1 className="text-lg font-semibold">{chunkFailed ? "This page needs a fresh copy" : "This page could not load"}</h1>
      <p className="mt-2 text-sm text-muted">{chunkFailed ? "The app was updated while this page was open." : "Try again or reload the app."}</p>
      <div className="mt-4 flex gap-2">
        {!chunkFailed && <button type="button" onClick={reset} className="rounded border border-line px-3 py-2 text-sm">Try again</button>}
        <button type="button" onClick={() => window.location.reload()} className="rounded bg-accent px-3 py-2 text-sm text-white">Reload</button>
      </div>
    </main>
  )
}
