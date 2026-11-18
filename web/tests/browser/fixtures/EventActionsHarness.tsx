import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { AuthProvider, useAuth } from '../../../src/auth/AuthProvider';
import { EventActions } from '../../../src/events/EventActions';
import { readEventDetails } from '../../../src/events/details';
import { eventDetails, timedTicketType } from '../event-fixture.mjs';

const event = readEventDetails({ ...eventDetails, ticket_types: [timedTicketType] }, eventDetails.id);

function Harness() {
  const { user, login } = useAuth();
  if (!user) {
    return <button type="button" onClick={() => { void login({ email: 'fixture@example.com', password: 'fixture-password' }); }}>
      Войти в тесте
    </button>;
  }
  return <EventActions event={event} remainingSeats={2} returnTo="/events/42" />;
}

createRoot(document.getElementById('root')!).render(
  <MemoryRouter>
    <AuthProvider><Harness /></AuthProvider>
  </MemoryRouter>,
);
