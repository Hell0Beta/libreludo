import { useEffect } from 'react';

/** Minimal shape so this does not depend on the Wake Lock types being present in `lib.dom`. */
type TWakeLockSentinel = {
  release: () => Promise<void>;
  addEventListener: (type: 'release', listener: () => void) => void;
};

type TNavigatorWithWakeLock = Navigator & {
  wakeLock?: { request: (type: 'screen') => Promise<TWakeLockSentinel> };
};

/**
 * Hold a screen wake lock while the host board is on screen.
 *
 * `useMoveTokenForward` awaits framer-motion animations step by step, and `requestAnimationFrame`
 * is throttled in a hidden tab — so a backgrounded host can stall a move. This keeps the screen
 * (and the tab) alive for the duration of the room. Feature-checked and released on unmount; a
 * browser that refuses the lock is not an error, the timeout in `useMoveTokenForward` is the
 * backstop.
 */
export function useWakeLock() {
  useEffect(() => {
    const nav = navigator as TNavigatorWithWakeLock;
    if (!nav.wakeLock) return;

    let sentinel: TWakeLockSentinel | null = null;
    let disposed = false;

    const request = async () => {
      try {
        const next = await nav.wakeLock.request('screen');
        if (disposed) {
          void next.release().catch(() => {});
          return;
        }
        sentinel = next;
        next.addEventListener('release', () => {
          sentinel = null;
        });
      } catch {
        // Denied or unsupported (e.g. insecure context). Not fatal.
      }
    };

    const handleVisibility = () => {
      if (document.visibilityState === 'visible' && !disposed && !sentinel) void request();
    };

    void request();
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', handleVisibility);
      if (sentinel) void sentinel.release().catch(() => {});
    };
  }, []);
}
