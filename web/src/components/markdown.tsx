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
import type { ReactNode } from "react"
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

function Code({ className, children }: { className?: string; children?: ReactNode }) {
  const source = String(children ?? "").replace(/\n$/, "")
  const language = /language-([\w-]+)/.exec(className ?? "")?.[1]
  if (!language) return <code className={className}>{children}</code>
  const tree = highlight(source, language)
  if (!tree) return <code className={className}>{source}</code>
  return <code className={cx(className, "hl")}>{tree.children?.map((child, index) => renderHast(child, index))}</code>
}

function Anchor({ href, children }: { href?: string; children?: ReactNode }) {
  const external = href ? /^https?:/i.test(href) : false
  return (
    <a href={href} {...(external ? { target: "_blank", rel: "noreferrer" } : {})}>
      {children}
    </a>
  )
}

const remarkPlugins = [remarkGfm]

export function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={remarkPlugins} components={{ code: Code, a: Anchor }}>
        {text}
      </ReactMarkdown>
    </div>
  )
}
