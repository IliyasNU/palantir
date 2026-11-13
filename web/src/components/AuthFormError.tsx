import { ApiError } from '../api';
import { authErrorMessage } from '../auth/formErrors';
import { useT } from '../i18n';

export function AuthFormError({ error, mode }: { error: unknown; mode: 'login' | 'register' }) {
  const t = useT();
  if (!error) return null;
  const labels: Record<string, string> = { email: t.auth.email, full_name: t.auth.name, password: t.auth.password };
  return (
    <div className="notice notice-error" role="alert" id="form-error">
      <p>{authErrorMessage(error, mode)}</p>
      {error instanceof ApiError && error.issues.length > 0 && (
        <ul>{error.issues.map((issue, index) => (
          <li key={`${issue.field}-${index}`}>{labels[issue.field] ?? issue.field}: {issue.message}</li>
        ))}</ul>
      )}
    </div>
  );
}
