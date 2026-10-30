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
// secondary entry points such as react/jsx-runtime, react-dom/client and scheduler. The old
// object form only pinned each package's main module, so Rollup pulled the JSX runtime into
// vendor-motion and the entry chunk then imported (and index.html modulepreloaded) all of
// framer-motion before first paint.
const VENDOR_CHUNKS = {
  react: 'vendor-react',
  'react-dom': 'vendor-react',
  scheduler: 'vendor-react',
  'react-router': 'vendor-react',
  'react-router-dom': 'vendor-react',
  'framer-motion': 'vendor-motion',
  'motion-dom': 'vendor-motion',
  'motion-utils': 'vendor-motion',
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
