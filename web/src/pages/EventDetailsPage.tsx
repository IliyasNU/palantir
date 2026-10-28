import { Link, useParams } from 'react-router';
import { Page } from '../components/Page';
import { useAuth } from '../auth/AuthProvider';
import { authLink } from '../auth/returnTo';

export function EventDetailsPage() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();

  return (
    <Page
      eyebrow={`Событие · ${id ?? ''}`}
      title="Подробнее о событии"
      description="Страница события находится в разработке."
    >
      <div className="content-card">
        <h2>Все детали в одном месте</h2>
        <p>Здесь появятся описание, дата, место проведения и информация об организаторе. Данные события пока не загружаются.</p>
        <Link className="button" to="/events">Вернуться к событиям</Link>
        {!user && <p><Link className="text-link" to={authLink('/login', `/events/${id}`)}>Войти и вернуться к этому событию</Link></p>}
      </div>
    </Page>
  );
}
