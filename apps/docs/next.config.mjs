import { createMDX } from 'fumadocs-mdx/next'

const withMDX = createMDX()

const editorIsolationHeaders = [
  { key: 'Cross-Origin-Embedder-Policy', value: 'require-corp' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
]

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  experimental: {
    useTypeScriptCli: true,
  },
  // Trace from the monorepo root: workspace dependencies and pnpm's package store live outside
  // this app's directory.
  outputFileTracingRoot: new URL('../../', import.meta.url).pathname,
  async headers() {
    return [
      {
        source: '/editor',
        headers: editorIsolationHeaders,
      },
      {
        source: '/editor/:path*',
        headers: editorIsolationHeaders,
      },
      {
        source: '/docs/:path*',
        headers: [{ key: 'Vary', value: 'Accept' }],
      },
    ]
  },
  async rewrites() {
    return [
      {
        source: '/docs/:path*.md',
        destination: '/llms.mdx/docs/:path*',
      },
    ]
  },
}

export default withMDX(config)
