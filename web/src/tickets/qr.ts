import QRCode from 'qrcode';

/** Local rendering only: the ticket bearer payload never goes to a QR service. */
export function ticketQrDataUrl(payload: string, width = 320): Promise<string> {
  return QRCode.toDataURL(payload, { errorCorrectionLevel: 'M', margin: 4, width,
    color: { dark: '#000000ff', light: '#ffffffff' } });
}
