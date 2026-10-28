import { Link, NavLink, Outlet, useLocation } from 'react-router';
import { useAuth } from '../auth/AuthProvider';
import { authLink, safeReturnTo } from '../auth/returnTo';

export function Layout() {
  const auth = useAuth();
  const location = useLocation();
  const returnTo = safeReturnTo(location.pathname === '/login' || location.pathname === '/register'
    ? new URLSearchParams(location.search).get('returnTo') : location.pathname);
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">Перейти к содержимому</a>
      <header className="site-header">
        <div className="container header-content">
          <Link className="brand" to="/events" aria-label="BiletFlow — события">
            <span className="brand-mark" aria-hidden="true">b.</span>
            BiletFlow
          </Link>
          <nav className="navigation" aria-label="Основная навигация">
            <NavLink className="nav-link" to="/events">События</NavLink>
            {auth.user ? (
              <>
                <span className="account-name">{auth.user.full_name}</span>
                <button className="nav-link nav-link-accent" type="button" onClick={auth.logout}>Выйти</button>
              </>
            ) : (
              <>
                <NavLink className="nav-link" to={authLink('/login', returnTo)}>Войти</NavLink>
                <NavLink className="nav-link nav-link-accent" to={authLink('/register', returnTo)}>Регистрация</NavLink>
              </>
            )}
          </nav>
        </div>
      </header>
      <main className="container main-content" id="main-content" tabIndex={-1}>
        {auth.notice && (
          <div className="notice notice-error session-notice" role="alert">
            <p>{auth.notice === 'expired' ? 'Сессия завершена. Войдите снова для продолжения.' : 'У вас недостаточно прав для этого действия.'}</p>
            {auth.notice === 'expired' && <Link className="text-link" to={authLink('/login', returnTo)}>Войти снова</Link>}
            <button className="text-button" type="button" onClick={auth.dismissNotice}>Закрыть сообщение</button>
          </div>
        )}
        <Outlet />
      </main>
      <footer className="site-footer">
        <div className="container footer-content">
          <span>BiletFlow</span>
          <span>События, которые объединяют.</span>
        </div>
      </footer>
    </div>
  );
}
