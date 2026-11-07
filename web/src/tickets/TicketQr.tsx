import { useEffect, useState } from 'react';
import { ticketQrDataUrl } from './qr';

export function TicketQr({ payload }: { payload: string }) {
  const [image, setImage] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    setImage(null);
    setFailed(false);
    ticketQrDataUrl(payload).then((url) => { if (active) setImage(url); })
      .catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [payload]);
  if (failed) return <p role="alert">Не удалось показать QR-код. Обновите страницу билета и войдите снова.</p>;
  return image ? <img className="ticket-qr" src={image} alt="QR-код билета для проверки на входе" width={320} height={320} />
    : <p role="status">Подготавливаем QR-код…</p>;
}
