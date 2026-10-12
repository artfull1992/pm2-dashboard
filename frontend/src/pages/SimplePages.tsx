import { Link } from 'react-router';
import { useAuth } from '../auth/AuthContext';
import { EmptyState } from '../components/StatusMessage';

// Honest empty states: there is no Agent / server API yet, so nothing here pretends to have data or controls.

export function DashboardPage() {
  const { state } = useAuth();
  const email = state.status === 'authenticated' ? state.session.user.email : '';
  return (
    <section className="page" aria-labelledby="dashboard-title">
      <h1 id="dashboard-title" className="page__title">Огляд</h1>
      <p className="page__lead">Вітаємо, {email}.</p>
      <div className="cards">
        <article className="card">
          <h2 className="card__title">Сервери</h2>
          <p className="card__text">Ще немає підключених серверів.</p>
          <Link className="card__link" to="/servers">Перейти до серверів</Link>
        </article>
        <article className="card">
          <h2 className="card__title">Застосунки</h2>
          <p className="card__text">Ще немає підключених застосунків.</p>
          <Link className="card__link" to="/applications">Перейти до застосунків</Link>
        </article>
      </div>
    </section>
  );
}

export function ApplicationsPage() {
  return (
    <section className="page" aria-labelledby="apps-title">
      <h1 id="apps-title" className="page__title">Застосунки</h1>
      <EmptyState title="Ще немає підключених застосунків">
        Застосунки з’являться тут, коли агент передасть дані про процеси.
      </EmptyState>
    </section>
  );
}

export function NotFoundPage() {
  return (
    <section className="page" aria-labelledby="nf-title">
      <h1 id="nf-title" className="page__title">Сторінку не знайдено</h1>
      <p className="page__lead"><Link to="/">Повернутися на головну</Link></p>
    </section>
  );
}
