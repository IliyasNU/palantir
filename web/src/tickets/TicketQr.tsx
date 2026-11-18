import { useEffect, useId, useRef, useState } from 'react';
import { useT } from '../i18n';
import { ticketQrDataUrl } from './qr';

export function TicketQr({ payload, size = 320, className = 'ticket-qr', alt }: {
  payload: string;
  /** Pixel width of the generated image; the quiet zone and error correction stay the same. */
  size?: number;
  className?: string;
  alt?: string;
}) {
  const t = useT().tickets;
  const [image, setImage] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    setImage(null);
    setFailed(false);
    ticketQrDataUrl(payload, size).then((url) => { if (active) setImage(url); })
      .catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [payload, size]);
  if (failed) return <p role="alert">{t.qrFailed}</p>;
  return image ? <img className={className} src={image} alt={alt ?? t.qrAlt} width={size} height={size} />
    : <p role="status">{t.qrPreparing}</p>;
}

/**
 * The same QR, black on white across the whole screen, for the entrance scanner. A native modal dialog
 * keeps focus inside and closes with Esc; focus then returns to the button that opened it.
 */
export function TicketQrFullscreen({ payload, title, subtitle }: { payload: string; title: string; subtitle: string }) {
  const t = useT().tickets;
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const headingId = useId();

  function show() {
    const element = dialog.current;
    if (!element || element.open) return;
    element.showModal();
    setOpen(true);
  }

  return <>
    <button ref={opener} className="button" type="button" aria-haspopup="dialog" onClick={show}>{t.qrFullscreen}</button>
    {/* onClose runs for the close button and for Esc alike. */}
    <dialog ref={dialog} className="qr-fullscreen" aria-labelledby={headingId}
      onClose={() => { setOpen(false); opener.current?.focus(); }}>
      <div className="qr-fullscreen-bar">
        <div>
          <h2 id={headingId}>{title}</h2>
          <p>{subtitle}</p>
        </div>
        <button className="qr-fullscreen-close" type="button" autoFocus onClick={() => dialog.current?.close()}>{t.qrClose}</button>
      </div>
      {open && <TicketQr payload={payload} size={1024} className="ticket-qr-large" alt={t.qrLargeAlt} />}
      <p className="qr-fullscreen-hint">{t.qrFullscreenHint}</p>
    </dialog>
  </>;
}
