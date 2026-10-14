import { Link } from 'react-router';

// Static pages: no data is shown here, so nothing pretends to be live.

export function NotFoundPage() {
  return (
    <section className="page" aria-labelledby="nf-title">
      <h1 id="nf-title" className="page__title">Сторінку не знайдено</h1>
      <p className="page__lead"><Link to="/">Повернутися на головну</Link></p>
    </section>
  );
}
