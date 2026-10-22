import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import { api } from "../api/client"
import { OPEN_TEST_COMMAND_EVENT } from "../lib/channel-settings"
import { qk } from "../state/keys"
import type { Approval, Run } from "../types"
import { ApprovalCard } from "./approval-card"

const approval: Approval = {
  id: "01DRZ3NDEKTSV4RRFFQ69G5DD8",
  channel_id: "01BRZ3NDEKTSV4RRFFQ69G5BB1",
  requested_by: "01ARZ3NDEKTSV4RRFFQ69G5AA2",
  title: "Push branch fz/run-demo to origin",
  detail: "Push the branch.\n\n```\ngit push origin HEAD\n```",
  state: "pending",
  options: [
    { key: "push", label: "Push", style: "primary" },
    { key: "hold", label: "Hold" },
    { key: "drop", label: "Drop", style: "danger" },
  ],
}

describe("ApprovalCard", () => {
  it("uses the channel cache for the no-checks warning in the approvals inbox", () => {
    const client = new QueryClient()
    client.setQueryData(qk.channels, [{ id: approval.channel_id, test_command: "go test ./..." }])
    const write: Approval = { ...approval, commit_message: "Fix thing" }
    const view = render(<QueryClientProvider client={client}><ApprovalCard approval={write} run={{ id: "run" } as Run} onResolve={vi.fn()} /></QueryClientProvider>)
    expect(screen.queryByText(/No checks ran/)).not.toBeInTheDocument()
    act(() => client.setQueryData(qk.channels, [{ id: approval.channel_id, test_command: "" }]))
    expect(view.container).toHaveTextContent("No checks ran")
  })

  it("puts decisions ahead of the commit box on narrow screens and links missing checks", async () => {
    const user = userEvent.setup()
    const openSettings = vi.fn((event: Event) => { (event as CustomEvent<{ handled: boolean }>).detail.handled = true })
    window.addEventListener(OPEN_TEST_COMMAND_EVENT, openSettings)
    const write: Approval = { ...approval, commit_message: "Fix thing", options: [{ key: "merge", label: "Merge", style: "primary" }] }
    render(<ApprovalCard approval={write} run={{ id: "run" } as Run} testCommand="" onResolve={vi.fn()} />)
    expect(screen.getByText(/No checks ran/)).toBeInTheDocument()
    expect(screen.getByRole("textbox", { name: "Commit message" }).closest("label")).toHaveClass("max-md:order-2")
    expect(screen.getByRole("button", { name: /Merge/ }).parentElement).toHaveClass("max-md:order-1")
    const settings = screen.getByRole("link", { name: /Set a test command/ })
    expect(settings).toHaveAttribute("href", `/c/${approval.channel_id}#test-command`)
    await user.click(settings)
    expect(openSettings).toHaveBeenCalledOnce()
    window.removeEventListener(OPEN_TEST_COMMAND_EVENT, openSettings)
    expect(screen.queryByText(/With this card focused/)).toHaveClass("hidden")
  })

  it("shows the exact Signal draft and sends either original or edited text", async () => {
    const user = userEvent.setup()
    const onResolve = vi.fn()
    const draft: Approval = { ...approval, title: "Send to Signal group people?", signal_draft: { conversation: "group:people", recipients: "group:people", message_id: "message", text: "First line\nSecond line" }, options: [{ key: "send", label: "Send" }, { key: "edit_send", label: "Edit and send" }, { key: "dont_send", label: "Don't send" }] }
    render(<ApprovalCard approval={draft} onResolve={onResolve} />)
    expect(screen.getByText("Recipients: group:people")).toBeInTheDocument()
    expect(document.querySelector("pre")?.textContent).toBe("First line\nSecond line")
    await user.click(screen.getByRole("button", { name: /^Send$/ }))
    expect(onResolve).toHaveBeenCalledWith("send")
    await user.click(screen.getByRole("button", { name: "Edit and send" }))
    const box = screen.getByRole("textbox", { name: "Edit message" })
    await user.clear(box)
    await user.type(box, "Edited")
    await user.click(screen.getByRole("button", { name: "Send edited text" }))
    expect(onResolve).toHaveBeenCalledWith("edit_send", "Edited")
    await user.click(screen.getByRole("button", { name: "Don't send" }))
    expect(onResolve).toHaveBeenCalledWith("dont_send")
  })

  it("shows who decided a Signal draft", () => {
    const draft: Approval = { ...approval, title: "Send to Signal group people?", state: "resolved", signal_draft: { conversation: "group:people", recipients: "group:people", message_id: "message", text: "original" }, resolution: { option: "send", by: "human", at: new Date().toISOString() } }
    render(<ApprovalCard approval={draft} decider="Director" onResolve={() => undefined} />)
    expect(screen.getByRole("article", { name: draft.title })).toHaveTextContent("by Director")
  })
  it("answers from the keyboard when the card is focused", async () => {
    const user = userEvent.setup()
    const onResolve = vi.fn()
    render(<ApprovalCard approval={approval} onResolve={onResolve} />)
    const card = screen.getByRole("article", { name: /Push branch/ })
    card.focus()
    await user.keyboard("2")
    expect(onResolve).toHaveBeenCalledWith("hold")
    await user.keyboard("{Enter}")
    expect(onResolve).toHaveBeenCalledWith("push")
  })

  it("sends the edited commit message with Merge only", async () => {
    const user = userEvent.setup()
    const onResolve = vi.fn()
    const write: Approval = {
      ...approval,
      title: "Choose what to do with branch fz/run-demo",
      commit_message: "Add the thing\n\nfaztudo run run-demo",
      options: [
        { key: "merge", label: "Merge", style: "primary" },
        { key: "keep", label: "Keep" },
      ],
    }
    render(<ApprovalCard approval={write} onResolve={onResolve} />)
    const box = screen.getByRole("textbox", { name: "Commit message" })
    expect(box).toHaveValue("Add the thing\n\nfaztudo run run-demo")
    await user.clear(box)
    await user.type(box, "Fix the thing")
    await user.click(screen.getByRole("button", { name: /Merge/ }))
    expect(onResolve).toHaveBeenLastCalledWith("merge", "Fix the thing")
    await user.click(screen.getByRole("button", { name: /Keep/ }))
    expect(onResolve).toHaveBeenLastCalledWith("keep")
  })

  it("shows no message box without a proposal", () => {
    render(<ApprovalCard approval={approval} onResolve={() => undefined} />)
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument()
  })

  describe("write approval", () => {
    const write: Approval = {
      ...approval,
      run_id: "01ERZ3NDEKTSV4RRFFQ69G5EE1",
      title: "Choose what to do with branch fz/run-demo",
      detail: "Merge fz/run-demo.",
      commit_message: "Add the thing",
      options: [
        { key: "merge", label: "Merge", style: "primary" },
        { key: "keep", label: "Keep" },
        { key: "discard", label: "Discard", style: "danger" },
      ],
    }
    const run = {
      id: "01ERZ3NDEKTSV4RRFFQ69G5EE1",
      diff_stat: { files: 3, insertions: 5, deletions: 1 },
      verification: { ok: true, detail: "go test ./...\nok" },
    } as Run
    const diff = [
      "diff --git a/a.go b/a.go",
      "--- a/a.go",
      "+++ b/a.go",
      "@@ -1 +1,2 @@",
      " package a",
      "+var x = 1",
      "diff --git a/b.ts b/b.ts",
      "--- a/b.ts",
      "+++ b/b.ts",
      "@@ -1 +1 @@",
      "-const old = 1",
      "+const next = 2",
      "diff --git a/c.md b/c.md",
      "--- a/c.md",
      "+++ b/c.md",
      "@@ -1 +1 @@",
      "-before",
      "+after",
      "",
    ].join("\n")

    function renderWrite(onResolve = vi.fn()) {
      render(<ApprovalCard approval={write} run={run} agentName="Coder" agentHandle="coder" diff={diff} onResolve={onResolve} />)
      return onResolve
    }

    it("saves a rule from the merge card and then merges", async () => {
      const user = userEvent.setup()
      const create = vi.spyOn(api, "createApprovalRule").mockResolvedValue({ id: "rule", channel_id: write.channel_id, persona: "coder", paths: ["a.go"], max_lines: 50, created_by: "human", created_at: new Date().toISOString() })
      const onResolve = renderWrite()
      await user.click(screen.getByRole("button", { name: "Always merge changes like this here" }))
      expect(screen.getByRole("dialog", { name: "Create approval rule" })).toHaveTextContent("Protected paths")
      expect(screen.getByRole("textbox", { name: "Allowed path globs" })).toHaveValue("a.go\nb.ts\nc.md")
      expect(screen.getByRole("spinbutton", { name: "Maximum changed lines" })).toHaveValue(50)
      await user.click(screen.getByRole("button", { name: "Save rule and merge" }))
      expect(create).toHaveBeenCalledWith({ channel_id: write.channel_id, persona: "coder", paths: ["a.go", "b.ts", "c.md"], max_lines: 50 })
      expect(onResolve).toHaveBeenCalledWith("merge", "Add the thing")
      create.mockRestore()
    })

    it("leads with one summary line, then files, checks and the options", () => {
      renderWrite()
      expect(screen.getByTestId("approval-summary")).toHaveTextContent("Merge Coder's change: 3 files, tests passed")
      const files = within(screen.getByRole("region", { name: "Changed files" }))
      expect(files.getByRole("button", { name: /a\.go/ })).toHaveTextContent("+1-0")
      expect(files.getByRole("button", { name: /b\.ts/ })).toHaveTextContent("+1-1")
      expect(screen.getByText("Checks passed")).toBeInTheDocument()
      expect(screen.getByRole("button", { name: /Merge/ })).toBeInTheDocument()
      expect(screen.getByRole("button", { name: /Discard/ })).toBeInTheDocument()
    })

    it("previews the first two files and folds the rest until asked", async () => {
      const user = userEvent.setup()
      renderWrite()
      // Syntax colors split a line into spans, so match on the line's text.
      const line = (text: string) => screen.queryByText((_, el) => el?.tagName === "DIV" && el.textContent === text)
      expect(line("+var x = 1")).toBeInTheDocument()
      expect(line("+const next = 2")).toBeInTheDocument()
      expect(line("+after")).not.toBeInTheDocument()
      await user.click(screen.getByRole("button", { name: "Show all 3 files" }))
      expect(line("+after")).toBeInTheDocument()
      expect(screen.queryByRole("button", { name: /Show all/ })).not.toBeInTheDocument()
    })

    it("opens failed checks", () => {
      render(
        <ApprovalCard
          approval={write}
          run={{ ...run, verification: { ok: false, detail: "FAIL: TestX" } } as Run}
          agentName="Coder"
          onResolve={() => undefined}
        />,
      )
      expect(screen.getByTestId("approval-summary")).toHaveTextContent("tests failed")
      expect(screen.getByText("FAIL: TestX")).toBeVisible()
    })

    it("merges with m and sends the edited message", async () => {
      const user = userEvent.setup()
      const onResolve = renderWrite()
      const card = screen.getByRole("article", { name: /Choose what to do/ })
      card.focus()
      await user.keyboard("e")
      const box = screen.getByRole("textbox", { name: "Commit message" })
      expect(box).toHaveFocus()
      await user.clear(box)
      await user.type(box, "Better words")
      await user.keyboard("{Escape}")
      expect(card).toHaveFocus()
      await user.keyboard("m")
      expect(onResolve).toHaveBeenCalledWith("merge", "Better words")
    })

    it("keeps with k", async () => {
      const user = userEvent.setup()
      const onResolve = renderWrite()
      screen.getByRole("article", { name: /Choose what to do/ }).focus()
      await user.keyboard("k")
      expect(onResolve).toHaveBeenCalledWith("keep")
    })

    it("asks before discarding, from the key and from the button", async () => {
      const user = userEvent.setup()
      const onResolve = renderWrite()
      screen.getByRole("article", { name: /Choose what to do/ }).focus()
      await user.keyboard("d")
      expect(onResolve).not.toHaveBeenCalled()
      expect(screen.getByRole("alertdialog")).toBeInTheDocument()
      await user.keyboard("{Escape}")
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument()
      await user.click(screen.getByRole("button", { name: /Discard/ }))
      expect(onResolve).not.toHaveBeenCalled()
      await user.click(screen.getByRole("button", { name: "Cancel" }))
      expect(onResolve).not.toHaveBeenCalled()
      await user.click(screen.getByRole("button", { name: /Discard/ }))
      await user.click(screen.getByRole("button", { name: /^Yes, discard/ }))
      expect(onResolve).toHaveBeenCalledWith("discard")
    })

    it("folds to one line after the decision", () => {
      render(
        <ApprovalCard
          approval={{
            ...write,
            state: "resolved",
            resolution: {
              option: "merge",
              by: "m1",
              at: new Date(Date.now() - 3 * 60_000).toISOString(),
              note: "Fast-forwarded fz/run-demo into the current branch as 1a2b3c4.",
            },
          }}
          decider="Thiago"
          run={run}
          diff={diff}
          onResolve={() => undefined}
        />,
      )
      expect(screen.getByText("Merged as 1a2b3c4")).toBeInTheDocument()
      expect(screen.getByText("by Thiago")).toBeInTheDocument()
      expect(screen.getByText(/\dm ago/)).toBeInTheDocument()
      expect(screen.queryByRole("button")).not.toBeInTheDocument()
      expect(screen.queryByRole("textbox")).not.toBeInTheDocument()
    })
  })

  it("shows the chosen option after it is resolved", () => {
    render(
      <ApprovalCard
        approval={{
          ...approval,
          state: "resolved",
          resolution: { option: "push", by: "01ARZ3NDEKTSV4RRFFQ69G5AA1", at: "2026-10-18T12:00:00.000Z" },
        }}
        onResolve={() => undefined}
      />,
    )
    expect(screen.getByText("Answered with Push")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /Push/ })).not.toBeInTheDocument()
  })
})
