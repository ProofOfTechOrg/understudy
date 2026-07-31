export function resolveAttendedTransition<Peer>(
  targetUrl: string,
  currentUrl: string | null,
  isolationFailed: boolean,
  acceptingPeer: Peer | null,
  activePeer: Peer | null,
): {
  sessionChanged: boolean;
  peer: Peer | null;
} {
  return {
    sessionChanged: isolationFailed || targetUrl !== currentUrl,
    peer: acceptingPeer ?? activePeer,
  };
}
