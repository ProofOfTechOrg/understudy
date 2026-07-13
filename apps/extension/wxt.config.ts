import { defineConfig } from 'wxt';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  srcDir: 'src',
  modules: ['@wxt-dev/module-react'],
  alias: {
    '@understudy/protocol': fileURLToPath(
      new URL('../../packages/protocol/src/index.ts', import.meta.url),
    ),
  },
  manifest: {
    minimum_chrome_version: '116',
    permissions: ['debugger', 'tabs', 'activeTab', 'storage', 'alarms'],
    host_permissions: ['<all_urls>'],
  },
});
