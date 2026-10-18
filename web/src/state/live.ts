import { useQueryClient } from "@tanstack/react-query"
import { useEffect } from "react"
import { api } from "../api/client"
import { StreamClient, streamUrl, type StreamStatus } from "../api/stream"
import { emitStreamEvent } from "./bus"
import { applyEvent } from "./cache"
import { setStreamStatus } from "./status"

export interface LiveDeps {
  fetchHead: () => Promise<number>
  makeClient: (afterSeq: number) => { start: () => void; stop: () => void }
  retryMs?: number
}

// Starts the stream at the head of the event log, not at 0, so a page load
// does not replay every old event. Events after the head are still delivered
// while the app loads its data. A dropped socket resumes from the last seen
// seq inside StreamClient.
export function startLiveStream(deps: LiveDeps): () => void {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let client: { start: () => void; stop: () => void } | null = null
  const begin = () => {
    deps
      .fetchHead()
      .then((head) => {
        if (stopped) return
        client = deps.makeClient(head)
        client.start()
      })
      .catch(() => {
        if (stopped) return
        timer = setTimeout(begin, deps.retryMs ?? 1000)
      })
  }
  begin()
  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
    client?.stop()
  }
}

export function useLiveStream(): void {
  const qc = useQueryClient()
  useEffect(() => {
    return startLiveStream({
      fetchHead: async () => (await api.streamHead()).seq,
      makeClient: (afterSeq) => {
        // Data a route loaded before the head was read may miss events from
        // that gap; one refetch closes it, the stream covers the rest.
        void qc.invalidateQueries()
        return new StreamClient({
          url: streamUrl(),
          afterSeq,
          onEvent: (event) => {
            applyEvent(qc, event)
            emitStreamEvent(event)
          },
          onStatus: (status: StreamStatus) => setStreamStatus(status),
        })
      },
    })
  }, [qc])
}
