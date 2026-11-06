import { Navigate, Route, Routes } from 'react-router';
import { Layout } from './components/Layout';
import { EventDetailsPage } from './pages/EventDetailsPage';
import { EventsPage } from './pages/EventsPage';
import { LoginPage } from './pages/LoginPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { RegisterPage } from './pages/RegisterPage';

export function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Navigate to="/events" replace />} />
        <Route path="events" element={<EventsPage />} />
        <Route path="events/:id" element={<EventDetailsPage />} />
        <Route path="login" element={<LoginPage />} />
        <Route path="register" element={<RegisterPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
