import { Link } from 'react-router';
import { useAuth } from '../auth/AuthContext';

// Static navigation pages: no data is shown here, so nothing pretends to be live.

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
          <p className="card__text">Реєстр серверів, стан агентів і ключі.</p>
          <Link className="card__link" to="/servers">Перейти до серверів</Link>
        </article>
        <article className="card">
          <h2 className="card__title">Застосунки</h2>
          <p className="card__text">PM2-процеси підключених серверів (лише перегляд).</p>
          <Link className="card__link" to="/applications">Перейти до застосунків</Link>
        </article>
      </div>
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
