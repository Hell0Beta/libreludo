import { type RouteConfig, index, route } from '@react-router/dev/routes';

export default [
  index('pages/HomePage/HomePage.tsx'),
  route('play', 'pages/Play/Play.tsx'),
  route('setup', 'pages/PlayerSetup/PlayerSetup.tsx'),
  route('how-to-play', 'pages/HowToPlay/HowToPlay.tsx'),
  // Networked host routes. Deliberately absent from `prerender` in react-router.config.ts:
  // they are room-scoped and must never be baked into a static shell.
  route('room/:code', 'pages/Room/Room.tsx'),
  // A PC that joined someone else's room: the same board, mirrored, and playable for its own seat.
  route('table/:code', 'pages/Table/Table.tsx'),
  // Phone routes. Also unprerendered — and they are the two the QR code points at, so they are the
  // first thing a device with no cached bundle ever loads.
  route('join/:code', 'pages/Join/Join.tsx'),
  route('controller/:code', 'pages/Controller/Controller.tsx'),
  route('*', 'pages/NotFound/NotFound.tsx'),
] satisfies RouteConfig;
