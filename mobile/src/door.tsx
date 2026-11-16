import { useEffect, useState } from 'react';
import { Text } from 'react-native';
import { api, type DoorDetails } from './api';
import { useLanguage } from './language';

// Who a ticket belongs to, its type and its seat, read next to a confirmed scan or a search result.
// It never decides anything: a failed read simply shows nothing, and admission stays with the check-in receipt.

const NONE: Map<number, DoorDetails> = new Map();

export function useDoorDetails(token: string, eventId: number, ticketIds: readonly number[]): Map<number, DoorDetails> {
  const key = [...ticketIds].sort((a, b) => a - b).join(',');
  // The answer is kept with the list it was asked for, so details of an earlier list are never shown for a new one.
  const [loaded, setLoaded] = useState<{ key: string; details: Map<number, DoorDetails> } | null>(null);

  useEffect(() => {
    if (!key) return;
    let current = true;
    void api.doorDetails(token, eventId, key.split(',').map(Number)).then(
      rows => { if (current) setLoaded({ key, details: new Map(rows.map(row => [row.ticket_id, row])) }); },
      () => { /* extra information only: nothing is shown without it */ },
    );
    return () => { current = false; };
  }, [token, eventId, key]);

  return loaded !== null && loaded.key === key ? loaded.details : NONE;
}

export function seatParts(label: string): { row: string; seat: string } {
  const [row = '', seat = ''] = label.split('-');
  return { row, seat };
}

// The lines for one ticket. `withName` is off where the name is already shown (search results).
export function DoorLines({ details, withName = true }: { details: DoorDetails | undefined; withName?: boolean }) {
  const { copy } = useLanguage();
  if (!details) return null;
  return <>
    {withName && <Text>{copy.doorVisitor(details.full_name)}</Text>}
    {details.ticket_type !== null && <Text>{copy.doorType(details.ticket_type)}</Text>}
    {details.seat_label !== null && <Text>{copy.doorSeat(seatParts(details.seat_label).row, seatParts(details.seat_label).seat)}</Text>}
  </>;
}

export function AdmittedDetails({ token, eventId, ticketId }: { token: string; eventId: number; ticketId: number }) {
  const details = useDoorDetails(token, eventId, [ticketId]);
  return <DoorLines details={details.get(ticketId)} />;
}
