import { defineConfig } from 'wxt';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

interface DeploymentTargets {
  production: { origin: string };
  staging: { origin: string; extensionPublicKey: string };
}

const deploymentTargets = JSON.parse(
  readFileSync(new URL('../../deployment-targets.json', import.meta.url), 'utf8'),
) as DeploymentTargets;
const PRODUCTION_ORIGIN = deploymentTargets.production.origin;
const STAGING_ORIGIN = deploymentTargets.staging.origin;
const STAGING_PUBLIC_KEY = deploymentTargets.staging.extensionPublicKey;

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
  manifest: ({ mode }) => {
    const staging = mode === 'staging';
    const serviceOrigin = staging ? STAGING_ORIGIN : PRODUCTION_ORIGIN;
    return {
      name:
        mode === 'store'
          ? 'Understudy Beta'
          : staging
            ? 'Understudy Staging'
            : 'Understudy',
      description:
        'BETA: Pair Chrome with Understudy so your authorized AI client can operate tabs on sites you allow.',
      minimum_chrome_version: '125',
      permissions: ['debugger', 'storage', 'alarms'],
      host_permissions:
        mode === 'store'
          ? [`${PRODUCTION_ORIGIN}/*`]
          : ['<all_urls>'],
      externally_connectable: {
        matches: [`${serviceOrigin}/*`],
      },
      ...(staging ? { key: STAGING_PUBLIC_KEY } : {}),
      icons: {
        16: 'icon-16.png',
        32: 'icon-32.png',
        48: 'icon-48.png',
        128: 'icon-128.png',
      },
      action: {
        default_title: 'Open Understudy',
      },
      homepage_url: `${serviceOrigin}/dashboard`,
    };
  },
  vite: ({ mode }) => ({
    define: {
      __UNDERSTUDY_STORE__: JSON.stringify(mode === 'store'),
      __UNDERSTUDY_ORIGIN_PINNED__: JSON.stringify(
        mode === 'store' || mode === 'staging',
      ),
      __UNDERSTUDY_SERVICE_ORIGIN__: JSON.stringify(
        mode === 'staging' ? STAGING_ORIGIN : PRODUCTION_ORIGIN,
      ),
      // Vite treats a custom mode as development unless NODE_ENV is pinned,
      // which otherwise bundles React's development runtime into the store ZIP.
      ...(mode === 'store' || mode === 'staging'
        ? { 'process.env.NODE_ENV': JSON.stringify('production') }
        : {}),
    },
    oxc:
      mode === 'store' || mode === 'staging'
        ? {
            jsx: {
              development: false,
            },
          }
        : undefined,
  }),
});
