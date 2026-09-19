import { defineConfig, configDefaults } from 'vitest/config';
import { reactRouter } from '@react-router/dev/vite';
import svgr from 'vite-plugin-svgr';
import checker from 'vite-plugin-checker';
import licenses from 'rollup-plugin-license';
import { ViteImageOptimizer } from 'vite-plugin-image-optimizer';
import { viteStaticCopy } from 'vite-plugin-static-copy';
import { VitePWA } from 'vite-plugin-pwa';
import { pwaOptions } from './pwa.config';
import { version, license } from './package.json';
import { normalizePath } from 'vite';
import path from 'node:path';

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  test: {
    environment: 'jsdom',
    // `.kilo` holds local git worktrees, which are complete copies of this repo. Without this
    // the whole suite is collected twice.
    exclude: [...configDefaults.exclude, '.kilo/**'],
    /*
     * `threads`, not the default `forks`.
     *
     * Under `forks` this suite intermittently loses a worker — roughly one run in four dies with
     * "Worker exited unexpectedly" and drops an entire test file's results. It is not silent
     * (vitest exits 1, so it cannot produce a false green), but a false red that often is worth
     * avoiding, and re-running to find out is a waste of everyone's time.
     *
     * The files most likely responsible are `tests/net/bridge` and `tests/net/controller`, which
     * each spawn the real relay as a child process and open several sockets next to a jsdom
     * document. `threads` does not fork a process per file. Measured: 13 consecutive clean runs on
     * `threads` against a ~25% failure rate on `forks`.
     *
     * `maxWorkers` is capped for the same reason — it keeps peak resource use down on a machine
     * that may also be running Docker. Raise either if the suite ever outgrows it.
     */
    pool: 'threads',
    maxWorkers: 3,
    coverage: {
      provider: 'istanbul',
      reporter: ['text', 'json', 'html'],
    },
  },
  css: {
    modules: {
      localsConvention: 'camelCaseOnly',
    },
  },
  define: {
    __LIBRELUDO_VERSION__: JSON.stringify(version),
    __LIBRELUDO_LICENSE__: JSON.stringify(license),
  },
  server: {
    proxy: {
      // Dev is two origins: Vite on 5173, the relay on 3210. Proxying the socket makes dev
      // same-origin, exactly like production where the relay serves the build itself — so no
      // client code ever needs a hardcoded dev URL. `ws` carries the websocket upgrade.
      //
      // 3210 must match `DEFAULT_PORT` in server/index.js. It is not 3000 because Docker Desktop
      // squats 127.0.0.1:3000 on Windows: the proxy would forward into Docker, Docker would answer
      // 404, and the app would report "Could not reach the relay" with nothing pointing at the port.
      '/socket.io': {
        target: 'http://127.0.0.1:3210',
        ws: true,
      },
    },
  },
  plugins: [
    // The React Router plugin injects a browser-only preamble check into every module that
    // references `react-router` — which includes `src/net/useRoom.ts`, since it imports
    // `useNavigate`. Under vitest that check throws "can't detect preamble" before a single test
    // runs, so no test could import a routing-aware module at all. No test exercises the route
    // tree itself, so the plugin sits out test mode rather than forcing a second config file
    // that would immediately drift from this one.
    mode === 'test' ? null : reactRouter(),
    svgr({
      svgrOptions: {
        plugins: ['@svgr/plugin-svgo', '@svgr/plugin-jsx'],
        svgoConfig: {
          plugins: ['preset-default'],
        },
      },
    }),
    checker({ typescript: { tsconfigPath: './tsconfig.app.json' } }),
    ViteImageOptimizer(),
    licenses({
      thirdParty: {
        output: normalizePath(
          path.resolve(import.meta.dirname, 'build/client/THIRD_PARTY_LICENSES.txt')
        ),
      },
    }),
    viteStaticCopy({
      targets: [
        {
          src: normalizePath(path.resolve(import.meta.dirname, 'LICENSE')),
          dest: normalizePath(path.resolve(import.meta.dirname, 'build/client')),
          rename: 'LICENSE.txt',
        },
      ],
    }),
    VitePWA(pwaOptions),
  ].filter((plugin) => plugin !== null),
}));
