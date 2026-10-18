// Dev only: run `npx vite` and open /avatar-gallery.html. This page is not an
// entry of the production build, which only reads index.html.
import { StrictMode, useState } from "react"
import { createRoot } from "react-dom/client"
import { AgentAvatar, type AvatarPerson, type AvatarSize, type AvatarState } from "../components/agent-avatar"
import "../index.css"

const SIZES: AvatarSize[] = [16, 20, 28, 36, 48, 96]
const STATES: (AvatarState | undefined)[] = [undefined, "working", "waiting", "failed", "off"]

function agent(handle: string, lane: string): AvatarPerson {
  const name = handle[0]!.toUpperCase() + handle.slice(1)
  return { id: `gallery-${handle}`, kind: "agent", handle, display_name: name, agent: { lanes: [lane] } }
}

const GROUPS: { title: string; members: AvatarPerson[] }[] = [
  {
    title: "Agent CLIs",
    members: ["claude", "codex", "agy", "kimi", "opencode", "grok"].map((handle) => agent(handle, `${handle}/default`)),
  },
  {
    title: "Personas (character of the first lane)",
    members: [
      agent("coder", "codex/default"),
      agent("reviewer", "claude/opus"),
      agent("architect", "kimi/default"),
      agent("writer", "grok/default"),
      agent("tester", "opencode/default"),
    ],
  },
  {
    title: "Human and unknown",
    members: [
      { id: "gallery-human", kind: "human", handle: "ada", display_name: "Ada Lovelace" },
      agent("zed", "mystery/x"),
    ],
  },
]

function Gallery() {
  const [dark, setDark] = useState(document.documentElement.classList.contains("dark"))
  function toggle() {
    document.documentElement.classList.toggle("dark", !dark)
    setDark(!dark)
  }
  return (
    <main className="mx-auto max-w-4xl p-6 text-ink">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Avatar gallery</h1>
        <button type="button" onClick={toggle} className="rounded border border-line px-3 py-1 text-[13px]">
          {dark ? "Light" : "Dark"}
        </button>
      </div>
      {GROUPS.map((group) => (
        <section key={group.title} className="mt-6">
          <h2 className="text-[13px] font-medium text-muted">{group.title}</h2>
          {group.members.map((member) => (
            <div key={member.id} className="mt-3 flex flex-wrap items-end gap-4 border-t border-line pt-3">
              <p className="w-24 text-[13px]">{member.display_name}</p>
              {SIZES.map((size) => (
                <AgentAvatar key={size} member={member} size={size} />
              ))}
            </div>
          ))}
        </section>
      ))}
      <section className="mt-8">
        <h2 className="text-[13px] font-medium text-muted">States at 48 px</h2>
        <div className="mt-3 flex flex-wrap gap-4">
          {STATES.map((state) => (
            <figure key={state ?? "none"} className="flex flex-col items-center gap-1">
              <AgentAvatar member={agent("coder", "codex/default")} size={48} state={state} />
              <figcaption className="text-[11px] text-muted">{state ?? "none"}</figcaption>
            </figure>
          ))}
        </div>
      </section>
    </main>
  )
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Gallery />
  </StrictMode>,
)
