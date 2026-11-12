import { Navigate, Route, Routes } from 'react-router';
import { AdminPage } from './pages/AdminPage';
import { Layout } from './components/Layout';
import { EventDetailsPage } from './pages/EventDetailsPage';
import { EventsPage } from './pages/EventsPage';
import { LoginPage } from './pages/LoginPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { RegisterPage } from './pages/RegisterPage';
import { TicketsPage } from './pages/TicketsPage';
import { TicketDetailsPage } from './pages/TicketDetailsPage';
import { TicketTypesPage } from './pages/TicketTypesPage';

export function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Navigate to="/events" replace />} />
        <Route path="events" element={<EventsPage />} />
        <Route path="events/:id" element={<EventDetailsPage />} />
        <Route path="tickets" element={<TicketsPage />} />
        <Route path="tickets/:id" element={<TicketDetailsPage />} />
        <Route path="admin" element={<AdminPage />} />
        <Route path="admin/:section" element={<AdminPage />} />
        <Route path="organizer/events/:id/ticket-types" element={<TicketTypesPage />} />
        <Route path="login" element={<LoginPage />} />
        <Route path="register" element={<RegisterPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
