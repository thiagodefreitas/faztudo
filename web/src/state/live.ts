import { useQueryClient } from "@tanstack/react-query"
import { useEffect } from "react"
import { StreamClient, streamUrl, type StreamStatus } from "../api/stream"
import { applyEvent } from "./cache"
import { setStreamStatus } from "./status"

export function useLiveStream(): void {
  const qc = useQueryClient()
  useEffect(() => {
    const client = new StreamClient({
      url: streamUrl(),
      afterSeq: 0,
      onEvent: (event) => applyEvent(qc, event),
      onStatus: (status: StreamStatus) => setStreamStatus(status),
    })
    client.start()
    return () => client.stop()
  }, [qc])
}
