import { Link } from 'react-router';
import { useT } from '../i18n';
import { Page } from '../components/Page';

export function NotFoundPage() {
  const t = useT().notFound;
  return (
    <Page
      eyebrow={t.eyebrow}
      title={t.title}
      description={t.description}
    >
      <Link className="button" to="/events">{t.toEvents}</Link>
    </Page>
  );
}
