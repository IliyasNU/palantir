import { canOrganize } from '../organizer/model';
import { Link, NavLink, Outlet, useLocation } from 'react-router';
import { useAuth } from '../auth/AuthProvider';
import { isAdmin } from '../admin/model';
import { authLink, safeReturnTo } from '../auth/returnTo';
import { locales, setLocale, useLocale, useT } from '../i18n';
import { VerifyEmailBanner } from './VerifyEmailBanner';

export function Layout() {
  const auth = useAuth();
  const t = useT();
  const locale = useLocale();
  const location = useLocation();
  const returnTo = safeReturnTo(location.pathname === '/login' || location.pathname === '/register'
    ? new URLSearchParams(location.search).get('returnTo') : location.pathname);
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">{t.common.skip}</a>
      <header className="site-header">
        <div className="container header-content">
          {/* The accessible name starts with the visible word, so voice control can say "BiletFlow" (WCAG 2.5.3). */}
          <Link className="brand" to="/events">
            <span className="brand-mark" aria-hidden="true">b.</span>
            <span aria-hidden="true">BiletFlow</span>
            <span className="visually-hidden">{t.common.brandLabel}</span>
          </Link>
          <nav className="navigation" aria-label={t.common.navLabel}>
            <NavLink className="nav-link" to="/events">{t.common.events}</NavLink>
            {auth.user ? (
              <>
                {canOrganize(auth.user) && <NavLink className="nav-link" to="/organizer">{t.organizer.nav}</NavLink>}
                <NavLink className="nav-link" to="/tickets">{t.common.myTickets}</NavLink>
                {isAdmin(auth.user) && <NavLink className="nav-link" to="/admin">{t.admin.nav}</NavLink>}
                <NavLink className="nav-link" to="/orders">{t.common.myOrders}</NavLink>
                <span className="account-name">{auth.user.full_name}</span>
                <button className="nav-link nav-link-accent" type="button" onClick={auth.logout}>{t.common.logout}</button>
              </>
            ) : (
              <>
                <NavLink className="nav-link" to={authLink('/login', returnTo)}>{t.common.login}</NavLink>
                <NavLink className="nav-link nav-link-accent" to={authLink('/register', returnTo)}>{t.common.register}</NavLink>
              </>
            )}
          </nav>
          <div className="language-switch" role="group" aria-label={t.common.language}>
            {locales.map((item) => (
              // The visible text is the name itself, so what is seen is what a screen reader or voice control hears.
              <button key={item.locale} className="language-option" type="button" lang={item.locale}
                aria-pressed={item.locale === locale} onClick={() => setLocale(item.locale)}>{item.name}</button>
            ))}
          </div>
        </div>
      </header>
      <main className="container main-content" id="main-content" tabIndex={-1}>
        {auth.notice && (
          <div className="notice notice-error session-notice" role="alert">
            <p>{auth.notice === 'expired' ? t.common.sessionExpired : t.common.forbidden}</p>
            {auth.notice === 'expired' && <Link className="text-link" to={authLink('/login', returnTo)}>{t.common.loginAgain}</Link>}
            <button className="text-button" type="button" onClick={auth.dismissNotice}>{t.common.closeNotice}</button>
          </div>
        )}
        <VerifyEmailBanner />
        <Outlet />
      </main>
      <footer className="site-footer">
        <div className="container footer-content">
          <span>BiletFlow</span>
          <span>{t.common.footer}</span>
        </div>
      </footer>
    </div>
  );
}
