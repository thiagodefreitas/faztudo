import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { identityOf } from "../lib/avatar"
import { AgentAvatar, type AvatarPerson, type AvatarSize } from "./agent-avatar"

const SIZES: AvatarSize[] = [16, 96]

function agent(handle: string, name: string, lanes: string[]): AvatarPerson {
  return { id: `id-${handle}`, kind: "agent", handle, display_name: name, agent: { lanes } }
}

const CLIS = ["claude", "codex", "agy", "kimi", "opencode", "grok"].map((handle) =>
  agent(handle, handle[0]!.toUpperCase() + handle.slice(1), [`${handle}/default`]),
)
const PERSONAS = ["coder", "reviewer", "architect", "writer", "tester"].map((handle) =>
  agent(handle, handle[0]!.toUpperCase() + handle.slice(1), ["codex/default"]),
)
const HUMAN: AvatarPerson = { id: "h1", kind: "human", handle: "ada", display_name: "Ada Lovelace" }
const UNKNOWN = agent("zed", "Zed", ["mystery/x"])

describe("AgentAvatar", () => {
  it.each(SIZES)("renders every avatar with its name at %i px", (size) => {
    const all = [...CLIS, ...PERSONAS, HUMAN, UNKNOWN]
    render(
      <div>
        {all.map((member) => (
          <AgentAvatar key={member.id} member={member} size={size} />
        ))}
      </div>,
    )
    for (const member of all) {
      const node = screen.getByRole("img", { name: member.display_name })
      expect(node).toHaveAttribute(member.kind === "agent" ? "width" : "style", expect.anything())
    }
    expect(screen.getAllByTestId("avatar")).toHaveLength(all.length)
  })

  it("gives each CLI its own character and no badge", () => {
    render(
      <div>
        {CLIS.map((member) => (
          <AgentAvatar key={member.id} member={member} />
        ))}
      </div>,
    )
    const shapes = CLIS.map((member) => screen.getByRole("img", { name: member.display_name }).innerHTML)
    expect(new Set(shapes).size).toBe(CLIS.length)
    for (const member of CLIS) {
      expect(screen.getByRole("img", { name: member.display_name })).not.toHaveAttribute("data-role")
    }
  })

  it("draws a persona as its first lane's CLI with a role badge", () => {
    render(<AgentAvatar member={PERSONAS[0]!} size={36} />)
    const coder = screen.getByRole("img", { name: "Coder" })
    expect(coder).toHaveAttribute("data-cli", "codex")
    expect(coder).toHaveAttribute("data-role", "coder")
    expect(coder.querySelectorAll("circle").length).toBeGreaterThan(0)
  })

  it("drops the badge at 16 px", () => {
    const { container } = render(<AgentAvatar member={PERSONAS[1]!} size={16} />)
    const small = container.innerHTML
    const large = render(<AgentAvatar member={PERSONAS[1]!} size={36} />).container.innerHTML
    expect(large.length).toBeGreaterThan(small.length)
  })

  it("is hidden from assistive tech when decorative", () => {
    render(<AgentAvatar member={CLIS[0]!} decorative />)
    expect(screen.queryByRole("img")).toBeNull()
    expect(screen.getByTestId("avatar")).toHaveAttribute("aria-hidden", "true")
  })

  it("animates only a working agent, with eyes that every character exposes", () => {
    render(
      <div>
        {CLIS.map((member) => (
          <AgentAvatar key={member.id} member={member} state="working" />
        ))}
        <AgentAvatar member={UNKNOWN} state="waiting" />
      </div>,
    )
    for (const member of CLIS) {
      const svg = screen.getByRole("img", { name: `${member.display_name}, working` })
      expect(svg).toHaveClass("fz-av-working")
      expect(svg.querySelector(".fz-av-orbit")).not.toBeNull()
      expect(svg.querySelector(".fz-av-eyes")).not.toBeNull()
    }
    const waiting = screen.getByRole("img", { name: "Zed, waiting" })
    expect(waiting).not.toHaveClass("fz-av-working")
    expect(waiting.querySelector(".fz-av-orbit")).toBeNull()
  })

  it("names the state and marks off agents", () => {
    render(<AgentAvatar member={CLIS[1]!} state="waiting" />)
    expect(screen.getByRole("img", { name: "Codex, waiting" })).toBeInTheDocument()
    render(<AgentAvatar member={CLIS[2]!} state="off" />)
    expect(screen.getByRole("img", { name: "Agy, off" })).toHaveClass("grayscale")
  })

  it("shows human initials", () => {
    render(<AgentAvatar member={HUMAN} />)
    expect(screen.getByRole("img", { name: "Ada Lovelace" })).toHaveTextContent("A")
  })
})

describe("identityOf", () => {
  it("resolves CLIs, personas and unknown agents", () => {
    expect(identityOf(CLIS[0]!)).toMatchObject({ cli: "claude", role: null, slot: 0 })
    expect(identityOf(PERSONAS[2]!)).toMatchObject({ cli: "codex", role: "architect", slot: 1 })
    expect(identityOf(PERSONAS[4]!)).toMatchObject({ cli: "codex", role: "other" })
    expect(identityOf(UNKNOWN)).toMatchObject({ cli: null, role: "other" })
  })
})
