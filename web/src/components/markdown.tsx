import { refractor } from "refractor/core"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { Link } from "@tanstack/react-router"
import { Children, isValidElement, useEffect, useMemo, useState, type ReactNode } from "react"
import { channelIdOf, channelLinks, type ChannelRef } from "../lib/channel-links"
import { cx } from "../lib/cx"

const LOADERS = {
  bash: () => import("refractor/bash"),
  css: () => import("refractor/css"),
  diff: () => import("refractor/diff"),
  go: () => import("refractor/go"),
  javascript: () => import("refractor/javascript"),
  json: () => import("refractor/json"),
  jsx: () => import("refractor/jsx"),
  markdown: () => import("refractor/markdown"),
  markup: () => import("refractor/markup"),
  python: () => import("refractor/python"),
  rust: () => import("refractor/rust"),
  sql: () => import("refractor/sql"),
  toml: () => import("refractor/toml"),
  tsx: () => import("refractor/tsx"),
  typescript: () => import("refractor/typescript"),
  yaml: () => import("refractor/yaml"),
} as const
type Language = keyof typeof LOADERS
const loading = new Map<Language, Promise<void>>()

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
  py: "python",
  python: "python",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  sql: "sql",
  html: "markup",
  htm: "markup",
  rust: "rust",
  rs: "rust",
}

function useLanguage(language: string | undefined): Language | undefined {
  const name = language ? ALIAS[language.toLowerCase()] as Language | undefined : undefined
  const [, loaded] = useState(0)
  useEffect(() => {
    if (!name || refractor.registered(name)) return
    let pending = loading.get(name)
    if (!pending) {
      pending = LOADERS[name]().then((module) => { refractor.register(module.default) }).catch(() => { loading.delete(name) })
      loading.set(name, pending)
    }
    let active = true
    void pending.then(() => { if (active) loaded((count) => count + 1) })
    return () => { active = false }
  }, [name])
  return name
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

function highlight(source: string, name: Language | undefined): HastNode | null {
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
  const name = useLanguage(language)
  const tree = highlight(source, name)
  if (!tree) return <>{source}</>
  return <>{tree.children?.map((child, index) => renderHast(child, index))}</>
}

function Code({ className, children }: { className?: string; children?: ReactNode }) {
  const source = String(children ?? "").replace(/\n$/, "")
  const language = /language-([\w-]+)/.exec(className ?? "")?.[1]
  const name = useLanguage(language)
  if (!language) return <code className={className}>{children}</code>
  const tree = highlight(source, name)
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
