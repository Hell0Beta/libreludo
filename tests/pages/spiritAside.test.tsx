// @vitest-environment jsdom
/**
 * The pairing QR appears on exactly one card, and never on a bot's.
 *
 * The bot case is the reason this file exists. It was found by looking at a screenshot, not by a
 * gate: a host had claimed player 1 and been given a pairing token, then flipped that player to a
 * bot in Match Setup. The server's `declareSeats` keeps an existing seat's tokens when its colour is
 * unchanged and refreshes only the name and `isBot` — so the host was left holding a valid token for
 * a seat the board now rolls for, and the card happily rendered a QR for it.
 *
 * Nothing about that fails loudly. A phone that scanned it paired successfully and then found every
 * roll and move refused, because `canMoveToken` and `rollBlockedReason` both reject bot seats — which
 * is indistinguishable, from the phone, from a board that is simply broken.
 *
 * **Assertions are on the hint text, not on the URL.** `qrcode.react` draws the payload as SVG
 * paths, so the string `#pair=…` never appears in the markup at all — an earlier draft of this file
 * asserted `not.toContain('#pair=')` and passed against a card that was in fact rendering a QR.
 * The hint is rendered by exactly the same `pairingUrl &&` branch as the code above it, so it is a
 * faithful proxy rather than a coincidence.
 *
 * Rendered to static markup rather than mounted: this is a pure function of its props, and the
 * assertions are about what is on the card.
 */

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import SpiritAside from '../../src/pages/Room/components/SpiritAside/SpiritAside';
import type { TSeatSummary } from '../../src/net/protocol';

/** Only ever rendered together with the QR — see the note above. */
const PAIRING_HINT = 'Scan to roll and move for';

function seat(colour: TSeatSummary['colour'], over: Partial<TSeatSummary> = {}): TSeatSummary {
  return {
    colour,
    name: colour[0].toUpperCase() + colour.slice(1),
    isBot: false,
    claimed: true,
    connected: true,
    paired: false,
    ...over,
  };
}

function render(
  seats: TSeatSummary[],
  pairing: { colour: TSeatSummary['colour']; url: string } | null
) {
  return renderToStaticMarkup(
    <SpiritAside
      seats={seats}
      currentPlayerColour="blue"
      isGameEnded={false}
      hostPresent
      pairing={pairing}
    />
  );
}

const PAIRING = { colour: 'blue' as const, url: 'https://example.test/join/ABCD#pair=tok' };

describe('SpiritAside pairing QR', () => {
  it('draws the QR on the card whose seat this device holds', () => {
    const markup = render([seat('blue'), seat('green')], PAIRING);
    expect(markup).toContain(PAIRING_HINT);
    // Exactly one card offers it, so exactly one code is drawn. Nothing else in this component
    // renders an `<svg>`, so the count is the count of QRs.
    expect(markup.split('<svg').length - 1).toBe(1);
  });

  it('draws nothing when this device holds no seat', () => {
    const markup = render([seat('blue'), seat('green')], null);
    expect(markup).not.toContain(PAIRING_HINT);
    expect(markup).not.toContain('<svg');
  });

  it('refuses to offer a seat the board rolls for', () => {
    // The host claimed blue, then Match Setup flipped it to a bot. The token is still valid; the
    // seat is not playable.
    const markup = render([seat('blue', { isBot: true }), seat('green')], PAIRING);
    expect(markup).not.toContain(PAIRING_HINT);
    expect(markup).toContain('Bot guardian');
  });

  it('still draws it for a seat that is merely disconnected', () => {
    // Away is not the same as out of play: the owner's claim survives a dropped socket, so the QR
    // is exactly what the host needs while the phone it is meant for is elsewhere.
    const markup = render([seat('blue', { connected: false })], PAIRING);
    expect(markup).toContain(PAIRING_HINT);
  });
});
