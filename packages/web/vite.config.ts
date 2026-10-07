import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { visualizer } from 'rollup-plugin-visualizer'

const rootDir = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, rootDir, '')
  const apiProxy = env.VITE_API_PROXY || 'http://127.0.0.1:3000'
  const analyze = mode === 'analyze'

  return {
    plugins: [
      react(),
      analyze &&
        visualizer({
          filename: path.resolve(rootDir, 'docs/bundle-stats.html'),
          gzipSize: true,
          brotliSize: true,
          open: false,
          template: 'treemap',
        }),
    ].filter(Boolean),
    build: {
      // print.css is linked from index.html with media="print"; left to the
      // default 4 KB limit Vite would inline it as a base64 data: URI, which
      // bloats the HTML every visitor downloads for a stylesheet almost none
      // of them apply. Keep stylesheets as real files; other assets keep the
      // default inlining behaviour.
      assetsInlineLimit: (filePath) => (filePath.endsWith('.css') ? false : undefined),
    },
    resolve: {
      alias: {
        '@known/product-v1': path.resolve(
          rootDir,
          '../server/generated/openapi/product-v1.ts',
        ),
        '@known/product-v1-client': path.resolve(
          rootDir,
          '../server/generated/openapi/product-v1.client.ts',
        ),
      },
    },
    server: {
      host: true,
      allowedHosts: ['know-n.com', '192.168.31.160', 'localhost'],
      port: 5173,
      strictPort: false,
      proxy: {
        // Same-origin /api → Product backend so Session cookies + CSRF work in dev
        '/api': {
          target: apiProxy,
          changeOrigin: true,
          secure: false,
        },
      },
    },
    preview: {
      host: true,
      port: 4173,
      proxy: {
        '/api': {
          target: apiProxy,
          changeOrigin: true,
          secure: false,
        },
      },
    },
  }
})
