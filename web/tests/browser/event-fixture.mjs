export const eventDetails = {
  id: 42, organizer_id: 7, title: 'Встреча разработчиков', description: 'Обсудим веб-приложения.\nВход со стороны площади.',
  date: '2030-07-15T00:30:00Z', location: 'Алматы, Большой зал', status: 'published', capacity: 100, tickets_issued: 12,
  created_at: '2030-01-01T00:00:00Z', updated_at: '2030-01-01T00:00:00Z',
};

export const salesClock = { before: '2030-07-01T10:00:00Z', start: '2030-07-01T10:00:03Z', end: '2030-07-01T10:00:08Z' };

export const timedTicketType = {
  id: 1, event_id: 42, name: 'Ранний вход', description: null, quantity: 2, tickets_issued: 0,
  remaining: 2, price_tiyn: 0, sales_start: salesClock.start, sales_end: salesClock.end, order_limit: 1, hidden: false,
};
