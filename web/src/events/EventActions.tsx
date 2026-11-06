import type { EventDetails } from './details';

export interface EventActionsProps {
  event: EventDetails;
  /** null means availability is unknown, not sold out. */
  remainingSeats: number | null;
  /** Sanitized path to return to after login. */
  returnTo: string;
}

/** Integration point for Sanjar's ticket action; mounted even for sold-out/cancelled events. */
export function EventActions(_props: EventActionsProps) {
  // Connect the ticket component here. It owns claiming and opening existing tickets.
  return null;
}
