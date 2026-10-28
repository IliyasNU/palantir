import { Page } from '../components/Page';

export function EventsPage() {
  return (
    <Page
      eyebrow="Афиша BiletFlow"
      title="Найдите повод быть вместе."
      description="Концерты, встречи и новые впечатления — всё начинается с события."
    >
      <div className="placeholder-card">
        <span className="ticket-mark" aria-hidden="true">↗</span>
        <div>
          <p className="eyebrow">Скоро здесь</p>
          <h2>Готовим афишу</h2>
          <p>Каталог событий пока в разработке. Здесь появятся события и переход к подробной информации о каждом из них.</p>
        </div>
      </div>
    </Page>
  );
}
