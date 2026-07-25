export function sendIfPeerCurrent<T>(
  admittedPeer: T | null,
  currentPeer: T | null,
  send: (peer: T) => void,
): void {
  if (admittedPeer !== null && admittedPeer === currentPeer) {
    send(admittedPeer);
  }
}
