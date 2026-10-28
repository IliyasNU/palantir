import { ApiError } from '../api';
import { authErrorMessage } from '../auth/formErrors';

const labels: Record<string, string> = { email: 'Email', full_name: 'Имя', password: 'Пароль' };

export function AuthFormError({ error, mode }: { error: unknown; mode: 'login' | 'register' }) {
  if (!error) return null;
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
