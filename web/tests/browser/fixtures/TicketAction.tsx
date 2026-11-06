import { useState } from 'react';
import type { EventActionsProps } from '../../../src/events/EventActions';

/** Test-only adapter proving the action slot stays interactive when full/cancelled. */
export function EventActions({ event, remainingSeats, returnTo }: EventActionsProps) {
  const [clicked, setClicked] = useState(false);
  return <button type="button" data-event-id={event.id} data-remaining={String(remainingSeats)}
    data-return-to={returnTo} onClick={() => setClicked(true)}>
    {clicked ? 'Действие подключено' : 'Тест: открыть существующий билет'}
  </button>;
}
