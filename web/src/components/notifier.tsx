import { useNavigate } from "@tanstack/react-router"
import { useEffect, useRef } from "react"
import { notificationFor } from "../lib/notify"
import { getNotifyPrefs, setNotificationsEnabled, toggleChannelMute, useNotifyPrefs } from "../lib/notify-prefs"
import { onStreamEvent } from "../state/bus"
import { useChannels, useMe, useMembers } from "../state/queries"

export function notificationsSupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window
}

// Desktop notifications for mentions, approvals and failed runs, and the
// unread count in the tab title. Renders nothing.
export function Notifier() {
  const navigate = useNavigate()
  const channels = useChannels()
  const members = useMembers()
  const me = useMe()
  const prefs = useNotifyPrefs()
  const seen = useRef(new Set<string>())
  // The listener reads the latest data through a ref, so it subscribes once.
  const latest = useRef({ channels: channels.data, members: members.data, meId: me.data?.id })
  useEffect(() => {
    latest.current = { channels: channels.data, members: members.data, meId: me.data?.id }
  }, [channels.data, members.data, me.data?.id])

  useEffect(() => {
    return onStreamEvent((event) => {
      const { channels: list, members: people, meId } = latest.current
      const current = getNotifyPrefs()
      if (!current.enabled || !notificationsSupported() || Notification.permission !== "granted") return
      if (!meId || !list || !people || seen.current.has(event.id)) return
      const item = notificationFor(event, { meId, members: people, channels: list, muted: new Set(current.muted), now: Date.now() })
      if (!item) return
      seen.current.add(event.id)
      // Someone looking at the page does not need a pop-up.
      if (document.visibilityState === "visible" && document.hasFocus()) return
      try {
        const popup = new Notification(item.title, { body: item.body, tag: event.id })
        popup.onclick = () => {
          window.focus()
          if (item.approvalId) void navigate({ to: "/approvals", search: { a: item.approvalId } })
          else void navigate({ to: "/c/$channelId", params: { channelId: item.channelId } })
          popup.close()
        }
      } catch {
        // Some mobile browsers only allow notifications from a service worker.
      }
    })
  }, [navigate])

  const base = useRef(typeof document === "undefined" || !document.title ? "faztudo" : document.title)
  const unread = (channels.data ?? []).reduce((sum, channel) => (prefs.muted.includes(channel.id) ? sum : sum + channel.unread), 0)
  useEffect(() => {
    document.title = unread > 0 ? `(${unread}) ${base.current}` : base.current
  }, [unread])

  return null
}

// The settings switch. Asking for permission needs a click, so it lives here
// and not in the notifier.
export function NotificationSettings() {
  const prefs = useNotifyPrefs()
  const supported = notificationsSupported()
  const denied = supported && Notification.permission === "denied"

  async function toggle(next: boolean) {
    if (!next) {
      setNotificationsEnabled(false)
      return
    }
    if (!supported) return
    const permission = Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission
    setNotificationsEnabled(permission === "granted")
  }

  return (
    <section className="mt-8 max-w-2xl" aria-labelledby="notify-heading">
      <h2 id="notify-heading" className="text-[14px] font-semibold">
        Notifications
      </h2>
      <p className="mt-1 text-[13px] text-muted">
        Show a desktop notification when someone mentions you, an approval is waiting or a run fails. Mute a single channel from its header.
      </p>
      <label className="mt-3 flex min-h-10 items-center gap-2 text-[13px]">
        <input
          type="checkbox"
          checked={prefs.enabled && supported}
          disabled={!supported || denied}
          onChange={(event) => void toggle(event.target.checked)}
          className="h-4 w-4 accent-accent"
        />
        Desktop notifications
      </label>
      {!supported && <p className="text-[12px] text-faint">This browser does not support notifications.</p>}
      {denied && <p className="text-[12px] text-faint">Notifications are blocked for this site in the browser settings.</p>}
      {prefs.muted.length > 0 && (
        <p className="mt-1 text-[12px] text-faint">
          {prefs.muted.length} muted {prefs.muted.length === 1 ? "channel" : "channels"}.{" "}
          <button type="button" className="underline" onClick={() => prefs.muted.forEach(toggleChannelMute)}>
            Unmute all
          </button>
        </p>
      )}
    </section>
  )
}
