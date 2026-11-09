/** Monitor network inactivity without reading or switching the body to flowing mode.
 * Official SDKs return IncomingMessage. Synthetic SDK streams without a socket
 * keep the caller's original bounded deadline instead.
 */
export function watchDownloadIdle(body, timeout, onTimeout) {
  const socket = body?.socket;
  if (!socket) return;
  socket.setTimeout(timeout);
  socket.once("timeout", onTimeout);
  let watching = true;
  return () => {
    if (!watching) return;
    watching = false;
    socket.removeListener("timeout", onTimeout);
    if (!socket.destroyed) socket.setTimeout(0);
  };
}
