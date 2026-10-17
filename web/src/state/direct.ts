import { useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { useCallback } from "react"
import { api } from "../api/client"
import { directName, findDirect } from "../lib/direct"
import type { Channel, Member } from "../types"
import { qk } from "./keys"
import { replaceById } from "./merge"

// Opens the DM with a member, creating the channel the first time. Resolves
// to the channel so callers can close their own UI around it.
export function useOpenDirect(): (other: Member) => Promise<Channel> {
  const qc = useQueryClient()
  const navigate = useNavigate()
  return useCallback(
    async (other: Member) => {
      const me: Member = qc.getQueryData<Member>(qk.me) ?? (await api.me())
      const channels = qc.getQueryData<Channel[]>(qk.channels) ?? (await api.channels())
      let channel = findDirect(channels, me.id, other.id)
      if (!channel) {
        channel = await api.createChannel({
          name: directName(me, other),
          kind: "direct",
          visibility: "direct",
          member_ids: [me.id, other.id],
        })
        const created = channel
        qc.setQueryData<Channel[]>(qk.channels, (list = []) => replaceById(list, created))
      }
      await navigate({ to: "/c/$channelId", params: { channelId: channel.id } })
      return channel
    },
    [qc, navigate],
  )
}
