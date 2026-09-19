/**
 * Which of the two device classes this is.
 *
 * The app has exactly two: a **phone**, which controls the dice and the pieces, and a **desktop**,
 * which shows the board. Which one you get decides where entering a room code sends you, so the
 * test has to be one both paths agree on.
 *
 * Two signals, because either alone misjudges something real:
 *   - `(hover: none) and (pointer: coarse)` is the honest test of "is this a touch device". It is
 *     the one to trust: a desktop window dragged narrow is still a desktop, and a large tablet is
 *     still a touch device.
 *   - A narrow viewport catches phones whose browsers report hover capability, and anyone using
 *     device emulation to check the phone layout.
 *
 * Deliberately evaluated at the moment of use rather than cached at module load: a window can be
 * resized between opening the menu and entering a code, and the answer should follow the window
 * the user is actually looking at.
 */

export const PHONE_MEDIA_QUERY = '(hover: none) and (pointer: coarse)';
export const NARROW_MEDIA_QUERY = '(max-width: 48rem)';

export function isPhoneDevice(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return (
    window.matchMedia(PHONE_MEDIA_QUERY).matches ||
    window.matchMedia(NARROW_MEDIA_QUERY).matches
  );
}
