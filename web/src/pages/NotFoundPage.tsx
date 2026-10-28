import { Link } from 'react-router';
import { Page } from '../components/Page';

export function NotFoundPage() {
  return (
    <Page
      eyebrow="Ошибка 404"
      title="Кажется, вы свернули не туда."
      description="Такой страницы нет. Проверьте адрес или вернитесь к событиям."
    >
      <Link className="button" to="/events">К событиям</Link>
    </Page>
  );
}
