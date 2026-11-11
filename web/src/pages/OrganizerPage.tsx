import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { useAuth } from '../auth/AuthProvider';
import { api } from '../api';

export function OrganizerPage() {
  const { user } = useAuth();
  const [events, setEvents] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const u = user as any;
  const isOrganizer = u?.role_id === 'organizer' || u?.role === 'organizer' || u?.role_id === 'admin' || u?.role === 'admin';

  useEffect(() => {
    if (!isOrganizer) {
      setLoading(false);
      return;
    }

    api.request('/events/mine')
      .then((res: any) => {
        setEvents(res.data ?? res);
        setLoading(false);
      })
      .catch((err: any) => {
        setError(err.message || 'Не удалось загрузить ваши события');
        setLoading(false);
      });
  }, [isOrganizer]);

  if (!isOrganizer) {
    return (
      <div className="container mx-auto px-4 py-12 text-center">
        <h1 className="text-xl font-bold text-red-600 mb-2">У вас нет прав для доступа к кабинету организатора</h1>
        <p className="text-gray-600 mb-6">Эта страница доступна только авторизованным организаторам.</p>
        <Link 
          to="/events" 
          className="inline-block bg-blue-600 text-white px-6 py-2 rounded hover:bg-blue-700"
        >
          Вернуться к каталогу событий
        </Link>
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-8">
      <h1 className="text-2xl font-bold mb-4">Кабинет организатора</h1>
      
      <div className="bg-white shadow rounded-lg p-6">
        <h2 className="text-xl font-semibold mb-4">Мои события</h2>

        {loading && <p className="text-gray-500">Загрузка событий...</p>}
        {error && <p className="text-red-500 mb-4">{error}</p>}

        {!loading && !error && (
          <div className="space-y-4">
            {events.length === 0 ? (
              <p className="text-gray-500">У вас пока нет созданных событий.</p>
            ) : (
              events.map((event: any) => (
                <div key={event.id} className="border p-4 rounded-lg flex justify-between items-center bg-gray-50">
                  <div>
                    <h3 className="font-bold text-lg">{event.title}</h3>
                    <p className="text-sm text-gray-500">
                      Статус: <span className="font-medium text-gray-700">{event.status}</span>
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-sm text-gray-600">Вместимость: {event.capacity}</p>
                    <p className="text-sm text-gray-600">Выдано билетов: {event.tickets_issued ?? 0}</p>
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}