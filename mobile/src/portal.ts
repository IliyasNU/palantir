export const portalAreas = ['attendee', 'organizer', 'admin'] as const;
type PortalArea = typeof portalAreas[number];

const paths: Record<PortalArea, string> = {
  attendee: '/events',
  organizer: '/organizer',
  admin: '/admin',
};

export function portalArea(value: unknown): PortalArea {
  return value === 'organizer' || value === 'admin' ? value : 'attendee';
}

export function portalEntry(value: string | undefined, area: PortalArea, dev: boolean) {
  try {
    if (!value) return null;
    const url = new URL(value.trim());
    const local = /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)\d/.test(url.hostname)
      && /^\d+\.\d+\.\d+\.\d+$/.test(url.hostname);
    if (url.protocol !== 'https:' && !(dev && local && url.protocol === 'http:')) return null;
    if (url.username || url.password || url.pathname !== '/' || /[?#]/.test(url.href)) return null;
    return { origin: url.origin, url: url.origin + paths[area] };
  } catch {
    return null;
  }
}

export function isPortalUrl(raw: string, origin: string) {
  try {
    const url = new URL(raw);
    return (url.protocol === 'http:' || url.protocol === 'https:')
      && url.origin === origin && !url.username && !url.password;
  } catch {
    return false;
  }
}

const maxPdfBase64Length = Math.ceil(2 * 1024 * 1024 / 3) * 4;

/** Android WebView can report just the sender's origin, without a document path. */
export function readTicketPdfMessage(message: string, sourceUrl: string, origin: string) {
  if (!isPortalUrl(sourceUrl, origin) || message.length > maxPdfBase64Length + 128) return null;

  try {
    const data: unknown = JSON.parse(message);
    if (typeof data !== 'object' || data === null || !('type' in data) || data.type !== 'biletflow-ticket-pdf'
      || !('ticketId' in data) || typeof data.ticketId !== 'number' || !Number.isSafeInteger(data.ticketId)
      || data.ticketId < 1 || !('base64' in data) || typeof data.base64 !== 'string') return null;
    if (data.base64.length > maxPdfBase64Length || data.base64.length % 4 !== 0
      || !/^JVBERi0[A-Za-z0-9+/]*={0,2}$/.test(data.base64)) return null;
    return { name: `biletflow-ticket-${data.ticketId}.pdf`, base64: data.base64 };
  } catch {
    return null;
  }
}
