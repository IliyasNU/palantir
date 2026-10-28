import { createApiClient } from './client';

// Vite injects VITE_* values at dev-server start / build time.
export const api = createApiClient(import.meta.env.VITE_API_URL);

export { ApiError, getErrorMessage } from './client';
export type { ApiErrorKind, ApiRequestOptions, ValidationIssue } from './client';
