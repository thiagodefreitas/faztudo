// Copies ../docs/**/*.md into src/content/docs/ (excluding docs/wiki/).
// Files without frontmatter get a title from their first "# " heading, which is stripped.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, '../../docs');
const dest = path.resolve(here, '../src/content/docs');
const KEEP = new Set(['index.mdx']);

async function clean() {
  await fs.mkdir(dest, { recursive: true });
  for (const e of await fs.readdir(dest)) {
    if (KEEP.has(e)) continue;
    await fs.rm(path.join(dest, e), { recursive: true, force: true });
  }
}

async function* walk(dir, rel = '') {
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const r = path.posix.join(rel, e.name);
    if (e.isDirectory()) {
      if (r === 'wiki') continue;
      yield* walk(path.join(dir, e.name), r);
    } else if (e.isFile() && e.name.endsWith('.md')) {
      yield r;
    }
  }
}

function transform(text) {
  if (/^---\r?\n/.test(text)) return text;
  const lines = text.split(/\r?\n/);
  const i = lines.findIndex((l) => /^# /.test(l));
  let title = 'Untitled';
  if (i >= 0) {
    title = lines[i].replace(/^# /, '').trim();
    lines.splice(i, 1);
  }
  const safe = title.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `---\ntitle: "${safe}"\n---\n${lines.join('\n').replace(/^\n+/, '')}`;
}

await clean();
let n = 0;
try {
  await fs.access(src);
  for await (const rel of walk(src)) {
    const out = path.join(dest, rel);
    await fs.mkdir(path.dirname(out), { recursive: true });
    await fs.writeFile(out, transform(await fs.readFile(path.join(src, rel), 'utf8')));
    n++;
  }
} catch (e) {
  if (e.code !== 'ENOENT') throw e;
}
console.log(`sync-docs: copied ${n} file(s) from ${src}`);
