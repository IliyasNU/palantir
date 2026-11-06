import { useEffect } from 'react';
import type { ReactNode } from 'react';

interface PageProps {
  eyebrow: string;
  title: string;
  description: string;
  children: ReactNode;
}

export function Page({ eyebrow, title, description, children }: PageProps) {
  useEffect(() => {
    document.title = `${title} — BiletFlow`;
  }, [title]);

  return (
    <section className="page" aria-labelledby="page-title">
      <div className="page-heading">
        <p className="eyebrow">{eyebrow}</p>
        <h1 id="page-title">{title}</h1>
        <p className="page-description">{description}</p>
      </div>
      {children}
    </section>
  );
}
