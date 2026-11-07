import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// The security headers live in vercel.json, the production source of truth. `vite preview`
// serves the same catch-all set, so smoke, a11y and the e2e suite all run under the production
// CSP. The dev server stays header-free: React Fast Refresh injects an inline preamble script.
function productionSecurityHeaders() {
  const vercel = JSON.parse(readFileSync(new URL('./vercel.json', import.meta.url), 'utf8'))
  const rule = vercel.headers.find((h) => h.source === '/(.*)')
  if (!rule) throw new Error('vercel.json has no catch-all "/(.*)" header rule')
  return Object.fromEntries(rule.headers.map(({ key, value }) => [key, value]))
}

// Vendor chunks by npm package. The function form assigns every module of a package, including
// secondary entry points such as react/jsx-runtime, react-dom/client and scheduler. (The old
// object form only pinned each package's main module, so Rollup once pulled the JSX runtime into
// a lazy vendor chunk and the entry chunk then imported, and index.html modulepreloaded, all of
// it before first paint.) There is no animation library: overlays and the ledger swipe move with
// CSS transitions and the Web Animations API (src/ui/motion.ts, usePresence.ts, spring.ts).
const VENDOR_CHUNKS = {
  react: 'vendor-react',
  'react-dom': 'vendor-react',
  scheduler: 'vendor-react',
  'react-router': 'vendor-react',
  'react-router-dom': 'vendor-react',
  'date-fns': 'vendor-utils',
  'fuse.js': 'vendor-utils',
  zustand: 'vendor-utils',
}

function vendorChunk(id) {
  const path = id.replace(/\\/g, '/')
  // Rollup's CommonJS interop helper is only needed by React's CJS builds.
  if (path.includes('commonjsHelpers')) return 'vendor-react'
  const at = path.lastIndexOf('/node_modules/')
  if (at < 0) return undefined
  const [first = '', second = ''] = path.slice(at + '/node_modules/'.length).split('/')
  const pkg = first.startsWith('@') ? `${first}/${second}` : first
  return Object.hasOwn(VENDOR_CHUNKS, pkg) ? VENDOR_CHUNKS[pkg] : undefined
}

// The data engine (src/data/local/engine.ts, the core with it) is a dynamic import that main.tsx
// starts before React renders (P2-1). With no hint the browser finds it only once the entry chunk
// has run, a round trip after vendor-react, and every boot waited for that serial fetch before
// the data showed. This modulepreloads the engine chunk and its own static imports (in a relay
// build, the core it shares with the sync engine) from index.html. They are marked data-boot:
// they download beside the entry chunk but first paint does not need them, and
// scripts/check-relay-weight.mjs counts them as the boot path, apart from what paints first.
const ENGINE_MODULE = '/src/data/local/engine.ts'

function preloadDataEngine() {
  let base = '/'
  return {
    name: 'spendtrack:preload-data-engine',
    apply: 'build',
    configResolved(config) {
      base = config.base
    },
    transformIndexHtml: {
      order: 'post',
      handler(html, ctx) {
        const bundle = ctx.bundle
        if (!bundle) return html
        const chunks = Object.values(bundle).filter((c) => c.type === 'chunk')
        // By the modules it holds, not its facade: the Recovery centre's lazy chunk (PR-4)
        // imports modules that live in the engine chunk, which then exports more than the
        // engine's own names and has no facade module (the dynamic import reads a namespace).
        const isEngine = (id) => id.replace(/\\/g, '/').endsWith(ENGINE_MODULE)
        const engine = chunks.find((c) => c.isDynamicEntry && c.moduleIds.some(isEngine))
        if (!engine) throw new Error(`No chunk for ${ENGINE_MODULE}: is it still a dynamic import?`)
        const files = []
        const visit = (chunk) => {
          if (files.includes(chunk.fileName)) return
          files.push(chunk.fileName)
          for (const dep of chunk.imports) {
            const next = bundle[dep]
            if (next?.type === 'chunk') visit(next)
          }
        }
        visit(engine)
        // the entry chunk and its vendor chunks are in index.html already
        return files
          .filter((file) => !html.includes(file))
          .map((file) => ({
            tag: 'link',
            attrs: {
              rel: 'modulepreload',
              crossorigin: true,
              href: `${base}${file}`,
              'data-boot': 'engine',
            },
            injectTo: 'head',
          }))
      },
    },
  }
}

// The release the app was built from, shown in Settings › Sync so the owner can check that every
// device runs the same one.
const APP_VERSION = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
).version

// https://vite.dev/config/
export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION),
  },
  build: {
    modulePreload: {
      // The data engine runs only after the entry chunk and its vendor chunks have loaded: a
      // chunk the engine loads later (the Recovery centre, PR-4) lists none of them, nor itself
      // (its import() fetches it), in the engine chunk, which every boot downloads (the startup
      // budget). Vite adds CSS deps after this.
      resolveDependencies: (file, deps, { hostId, hostType }) =>
        hostType === 'js' && /(^|\/)engine-[\w-]+\.js$/.test(hostId)
          ? deps.filter(
              (dep) => dep !== file && !/(^|\/)(index|vendor-[a-z]+)-[\w-]+\.js$/.test(dep),
            )
          : deps,
    },
    rollupOptions: {
      output: {
        manualChunks: vendorChunk,
      },
    },
  },
  preview: {
    headers: productionSecurityHeaders(),
    // Same-origin only, like production. The default CORS middleware adds `Vary: Origin`, which
    // makes WebKit ignore the font preloads in index.html and fetch every face twice.
    cors: false,
  },
  plugins: [
    react(),
    preloadDataEngine(),
    VitePWA({
      // Prompt-style updates. A new deploy installs its worker and then WAITS: the running page
      // keeps its old precache (so lazy screens it has not opened yet still load) until the user
      // accepts the in-app banner, which posts { type: 'SKIP_WAITING' }. The app registers
      // /sw.js itself (production only), so nothing is injected here and no registerSW.js ships.
      registerType: 'prompt',
      injectRegister: false,
      // Install-time icons are fetched by the OS, never offline by the app: keep every PNG out
      // of the precache. favicon.svg is precached through globPatterns (listing it here as well
      // would precache it twice).
      includeAssets: [],
      includeManifestIcons: false,
      manifest: {
        // Matches the implicit id (= start_url) of existing installs, so they are not orphaned.
        id: '/pulse',
        name: 'SpendTrack — Local-first spending tracker',
        short_name: 'SpendTrack',
        description:
          'A fast, local-first spending tracker with smart categorisation, real-time budgets, and optional cross-device sync.',
        start_url: '/pulse',
        scope: '/',
        display: 'standalone',
        launch_handler: { client_mode: ['focus-existing', 'auto'] },
        // --surface-0 of the dark theme; index.html switches the meta theme-color per theme.
        background_color: '#0c0b0a',
        theme_color: '#0c0b0a',
        categories: ['finance', 'productivity'],
        lang: 'en',
        dir: 'ltr',
        icons: [
          { src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          // Full-bleed and opaque, with the mark inside the central safe zone
          // (rendered by scripts/render-icons.mjs).
          {
            src: '/icon-maskable-192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'maskable',
          },
          {
            src: '/icon-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
        shortcuts: [
          {
            name: 'Add expense',
            short_name: 'Add',
            description: 'Log a new expense',
            url: '/pulse?add=1',
            icons: [{ src: '/shortcut-add-96.png', sizes: '96x96', type: 'image/png' }],
          },
        ],
      },
      workbox: {
        skipWaiting: false,
        // On the very first install the page has no worker yet; claiming it at once makes the
        // first visit offline-capable without a reload. Later updates wait for SKIP_WAITING.
        clientsClaim: true,
        cleanupOutdatedCaches: true,

        // App shell, code, styles, the favicon and the 8 self-hosted fonts. No PNGs.
        globPatterns: ['**/*.{js,css,html,svg,woff2}'],

        // All navigation requests fall back to index.html so React Router
        // handles routing client-side — fixes direct load of /pulse, /ledger, etc.
        navigateFallback: 'index.html',
        navigateFallbackDenylist: [/^\/api\//, /^\/sw\.js$/, /^\/workbox-/],
      },
      devOptions: {
        enabled: false,
      },
    }),
  ],
})
