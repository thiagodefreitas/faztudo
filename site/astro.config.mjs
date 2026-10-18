import { existsSync } from 'node:fs';
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

const docsDir = new URL('./src/content/docs/', import.meta.url);

// Only list pages that exist, so the build tolerates docs not written yet.
function pages(slugs) {
  return slugs
    .filter((s) => ['.md', '.mdx'].some((e) => existsSync(new URL(s + e, docsDir))))
    .map((slug) => ({ slug }));
}

function dirGroup(label, directory) {
  return existsSync(new URL(directory + '/', docsDir))
    ? [{ label, items: [{ autogenerate: { directory } }] }]
    : [];
}

function group(label, slugs) {
  const items = pages(slugs);
  return items.length ? [{ label, items }] : [];
}

function buildSidebar() {
  return [
    ...group('Start', ['getting-started']),
    ...group('Guides', ['tasks-and-approvals', 'projects']),
    ...group('Concepts', ['vision', 'architecture', 'organization', 'design']),
    ...group('Reference', ['api', 'configuration', 'bridge-protocol']),
    ...dirGroup('Decisions', 'adr'),
    ...group('Project', ['roadmap', 'versioning', 'contributing']),
  ];
}

export default defineConfig({
  site: 'https://thiagodefreitas.github.io',
  base: '/faztudo',
  integrations: [
    starlight({
      title: 'faztudo',
      description: 'A local-first, chat-first workspace for you and your AI coding agents.',
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/thiagodefreitas/faztudo' },
      ],
      logo: {
        light: '../assets/brand/logo.svg',
        dark: '../assets/brand/logo-dark.svg',
        alt: 'faztudo',
        replacesTitle: true,
      },
      favicon: '/favicon.svg',
      customCss: ['../assets/brand/tokens.css', './src/styles/custom.css'],
      sidebar: buildSidebar(),
    }),
  ],
});
