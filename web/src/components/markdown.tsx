import { refractor } from "refractor"
import bash from "refractor/bash"
import css from "refractor/css"
import diff from "refractor/diff"
import go from "refractor/go"
import javascript from "refractor/javascript"
import json from "refractor/json"
import jsx from "refractor/jsx"
import markdownLang from "refractor/markdown"
import tsx from "refractor/tsx"
import typescript from "refractor/typescript"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { Link } from "@tanstack/react-router"
import { Children, isValidElement, useMemo, useState, type ReactNode } from "react"
import { channelIdOf, channelLinks, type ChannelRef } from "../lib/channel-links"
import { cx } from "../lib/cx"

refractor.register(bash)
refractor.register(css)
refractor.register(diff)
refractor.register(go)
refractor.register(javascript)
refractor.register(json)
refractor.register(jsx)
refractor.register(markdownLang)
refractor.register(tsx)
refractor.register(typescript)

const ALIAS: Record<string, string> = {
  ts: "typescript",
  typescript: "typescript",
  js: "javascript",
  javascript: "javascript",
  jsx: "jsx",
  tsx: "tsx",
  go: "go",
  bash: "bash",
  sh: "bash",
  shell: "bash",
  json: "json",
  md: "markdown",
  markdown: "markdown",
  diff: "diff",
  css: "css",
}

interface HastNode {
  type: string
  value?: string
  properties?: { className?: string[] }
  children?: HastNode[]
}

function renderHast(node: HastNode, key: number): ReactNode {
  if (node.type === "text") return node.value
  if (node.type === "element") {
    const className = node.properties?.className?.join(" ")
    return (
      <span key={key} className={className}>
        {node.children?.map((child, index) => renderHast(child, index))}
      </span>
    )
  }
  return node.children?.map((child, index) => renderHast(child, index)) ?? null
}

function highlight(source: string, language: string): HastNode | null {
  const name = ALIAS[language]
  if (!name || !refractor.registered(name)) return null
  return refractor.highlight(source, name) as unknown as HastNode
}

/** The highlighter's language for a file path, if it knows one. */
export function languageOfPath(path: string): string | undefined {
  const ext = /\.([\w]+)$/.exec(path)?.[1]?.toLowerCase()
  return ext && ALIAS[ext] ? ext : undefined
}

/** One line of source with syntax colors; plain text for an unknown language. */
export function HighlightedLine({ source, language }: { source: string; language: string | undefined }) {
  const tree = language ? highlight(source, language) : null
  if (!tree) return <>{source}</>
  return <>{tree.children?.map((child, index) => renderHast(child, index))}</>
}

function Code({ className, children }: { className?: string; children?: ReactNode }) {
  const source = String(children ?? "").replace(/\n$/, "")
  const language = /language-([\w-]+)/.exec(className ?? "")?.[1]
  if (!language) return <code className={className}>{children}</code>
  const tree = highlight(source, language)
  if (!tree) return <code className={className}>{source}</code>
  return <code className={cx(className, "hl")}>{tree.children?.map((child, index) => renderHast(child, index))}</code>
}

function Anchor({ href, children }: { href?: string; children?: ReactNode }) {
  const channelId = channelIdOf(href)
  if (channelId) {
    return (
      <Link to="/c/$channelId" params={{ channelId }}>
        {children}
      </Link>
    )
  }
  const external = href ? /^https?:/i.test(href) : false
  return (
    <a href={href} {...(external ? { target: "_blank", rel: "noreferrer" } : {})}>
      {children}
    </a>
  )
}

// Block code gets a copy button. The inner code element carries the raw source.
function Pre({ children }: { children?: ReactNode }) {
  const [copied, setCopied] = useState(false)
  const inner = Children.toArray(children)[0]
  const source = isValidElement<{ children?: ReactNode }>(inner) ? String(inner.props.children ?? "").replace(/\n$/, "") : ""

  function copy() {
    void navigator.clipboard?.writeText(source).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  return (
    <div className="group/code relative mt-2">
      <pre>{children}</pre>
      <button
        type="button"
        onClick={copy}
        aria-label="Copy code"
        className="absolute right-1.5 top-1.5 min-h-7 rounded border border-line bg-surface px-2 text-[11px] text-muted opacity-100 transition-opacity duration-150 hover:text-ink md:opacity-0 md:group-hover/code:opacity-100 md:focus-visible:opacity-100"
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  )
}

const gfm = [remarkGfm]

// `channels` turns "#name" into a link to that channel. Callers without a
// channel list get plain text.
export function Markdown({ text, channels }: { text: string; channels?: ChannelRef[] | undefined }) {
  const remarkPlugins = useMemo(() => (channels ? [remarkGfm, channelLinks(channels)] : gfm), [channels])
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={remarkPlugins} components={{ code: Code, a: Anchor, pre: Pre }}>
        {text}
      </ReactMarkdown>
    </div>
  )
}
