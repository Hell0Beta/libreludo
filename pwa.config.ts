import type { VitePWAOptions } from 'vite-plugin-pwa';

export const pwaOptions: Partial<VitePWAOptions> = {
  outDir: 'build/client',
  registerType: 'prompt',
  filename: 'sw.js',
  injectRegister: false,
  manifest: {
    /*
     * "Sanctuary Edition" carries the fork in the name a player actually sees on their home screen.
     * The upstream project keeps its name — AGPL conveys no trademark rights, but it does not ask
     * for a rename either, and a fork that keeps the lineage visible while marking itself as the
     * modified version is the ordinary way this is done.
     *
     * `short_name` stays bare: it is what fits under the icon, and "LibreLudo Sanctuary" would be
     * truncated to something unreadable there anyway.
     */
    name: 'LibreLudo · Sanctuary Edition',
    short_name: 'LibreLudo',
    description:
      'Ad-free, open-source Ludo with local multiplayer, bot opponents, and a room you can invite phones into as controllers.',
    start_url: '/',
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: '#7C5FFF',
    icons: [
      {
        src: '/icons/favicon.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/icons/favicon.svg',
        sizes: 'any',
        type: 'image/svg+xml',
        purpose: 'maskable',
      },
    ],
  },
  workbox: {
    globDirectory: 'build/client',
    globPatterns: ['**/*.{js,css,html,ico,png,jpg,jpeg,svg,webp,gif,woff2,woff,ttf,eot,json}'],
    globIgnores: ['icons/favicon.png', 'icons/favicon.svg'],
    navigateFallbackDenylist: [
      /sitemap\.xml$/,
      /robots\.txt$/,
      /manifest\.webmanifest$/,
      /LICENSE\.txt$/,
      /THIRD_PARTY_LICENSES\.txt$/,
      // Socket.IO must never be answered by the SPA shell, or the service worker hands the
      // client an HTML document where it expected the handshake and reconnection breaks.
      // Verified invariant: `/socket.io/` answers `text/plain` from Socket.IO while an arbitrary
      // path gets the HTML shell (see server/index.js SOCKET_PATH). There is no runtimeCaching
      // config, so nothing else can cache this path either.
      /\/socket\.io\//,
    ],
    navigateFallback: '/index.html',
    mode: process.env.NODE_ENV,
    maximumFileSizeToCacheInBytes: 5 * 1024 * 1024, // 5 MB
    cleanupOutdatedCaches: true,
    clientsClaim: true,
    skipWaiting: false,
  },
};
