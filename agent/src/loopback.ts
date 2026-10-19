/**
 * True only when `ws` is a ws:// or wss:// URL whose hostname is exactly a
 * loopback name. A prefix regex would accept `ws://localhost.evil.example`;
 * parsing the URL and comparing the hostname closes that hole. Used by the
 * dev funding script, which spends //Alice and must never reach a real network.
 */
export function isLoopbackWs(ws: string): boolean {
  let url: URL;
  try {
    url = new URL(ws);
  } catch {
    return false;
  }
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') return false;
  return url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]';
}
