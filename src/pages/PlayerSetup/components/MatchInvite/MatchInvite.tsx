import InvitePanel from '../../../../components/InvitePanel/InvitePanel';
import { useRoom } from '../../../../net/useRoom';
import type { TSeatDefinition } from '../../../../net/protocol';

/**
 * The invite panel for Match Setup, and the only place on this screen that talks to the relay.
 *
 * It is a separate component for a reason: `useRoom` opens a socket, rehosts or *creates* a room,
 * and starts projecting state. Mounting it unconditionally would mean the local hotseat setup — the
 * one path that must never touch the network — silently creating a room behind the player's back
 * every time they opened `/setup`. Rendering it only when hosting keeps the two paths genuinely
 * separate rather than separated by a flag inside the hook.
 */

type Props = {
  roomCode: string;
  seats: TSeatDefinition[];
};

export default function MatchInvite({ roomCode, seats }: Props) {
  const { code, seats: serverSeats, hostPresent } = useRoom({ code: roomCode, seats });

  return (
    <InvitePanel code={code ?? roomCode} seats={serverSeats} hostPresent={hostPresent} />
  );
}
