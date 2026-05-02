import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          "vendor-react": ["react", "react-dom", "react-router-dom"],
          "vendor-motion": ["framer-motion"],
          "vendor-utils": ["date-fns", "fuse.js", "zustand"],
        },
      },
    },
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      // Take control of all clients immediately on activation — prevents
      // the old SW serving stale shells while the new one waits.
      injectRegister: 'auto',
      includeAssets: ['favicon.svg'],
      manifest: {
        name: 'SpendTrack',
        short_name: 'SpendTrack',
        description: 'Minimal personal spending tracker with smart categorisation.',
        start_url: '/pulse',
        display: 'standalone',
        background_color: '#07090D',
        theme_color: '#07090D',
        orientation: 'portrait',
        icons: [
          {
            src: '/favicon.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'any',
          },
          {
            src: '/favicon.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        // Activate the new SW immediately instead of waiting for all tabs to close.
        // This ensures /pulse and other sub-routes are never served by a stale SW.
        skipWaiting: true,
        clientsClaim: true,
        cleanupOutdatedCaches: true,

        // Precache all static assets
        globPatterns: ['**/*.{js,css,html,svg,png,ico,woff2}'],

        // All navigation requests fall back to index.html so React Router
        // handles routing client-side — fixes direct load of /pulse, /ledger, etc.
        navigateFallback: 'index.html',
        navigateFallbackDenylist: [/^\/api\//, /^\/sw\.js$/, /^\/workbox-/],

        runtimeCaching: [
          {
            urlPattern: /^https:\/\/fonts\.googleapis\.com\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'google-fonts-cache',
              expiration: { maxEntries: 10, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
      devOptions: {
        enabled: false,
      },
    }),
  ],
})
