import { defineConfig } from 'wxt';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  srcDir: 'src',
  outDirTemplate: '{{browser}}-mv{{manifestVersion}}{{modeSuffix}}',
  zip: {
    artifactTemplate: 'understudyextension-{{version}}-{{browser}}-{{mode}}.zip',
  },
  modules: ['@wxt-dev/module-react'],
  alias: {
    '@understudy/protocol': fileURLToPath(
      new URL('../../packages/protocol/src/index.ts', import.meta.url),
    ),
  },
  manifest: ({ mode }) => ({
    name: mode === 'store' ? 'Understudy Beta' : 'Understudy',
    description:
      'BETA: Pair Chrome with Understudy so your authorized AI client can operate tabs on sites you allow.',
    minimum_chrome_version: '125',
    permissions: ['debugger', 'storage', 'alarms'],
    host_permissions:
      mode === 'store'
        ? ['https://understudy.proofof.tech/*']
        : ['<all_urls>'],
    icons: {
      16: 'icon-16.png',
      32: 'icon-32.png',
      48: 'icon-48.png',
      128: 'icon-128.png',
    },
    action: {
      default_title: 'Open Understudy',
    },
    homepage_url: 'https://understudy.proofof.tech/dashboard',
  }),
  vite: ({ mode }) => ({
    define: {
      __UNDERSTUDY_STORE__: JSON.stringify(mode === 'store'),
      // Vite treats a custom mode as development unless NODE_ENV is pinned,
      // which otherwise bundles React's development runtime into the store ZIP.
      ...(mode === 'store'
        ? { 'process.env.NODE_ENV': JSON.stringify('production') }
        : {}),
    },
    oxc:
      mode === 'store'
        ? {
            jsx: {
              development: false,
            },
          }
        : undefined,
  }),
});
