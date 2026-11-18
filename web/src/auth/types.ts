export interface User {
  id: number;
  email: string;
  full_name: string;
  role: string;
  is_active: boolean;
  created_at: string;
  /** Absent when the API predates email verification. */
  email_verified?: boolean;
}

export interface LoginInput {
  email: string;
  password: string;
}

/** The roles anyone may choose at registration; admins are created on the server only. */
export const registrationRoles = ['attendee', 'organizer'] as const;
export type RegistrationRole = typeof registrationRoles[number];

export function isRegistrationRole(value: unknown): value is RegistrationRole {
  return typeof value === 'string' && (registrationRoles as readonly string[]).includes(value);
}

export interface RegistrationInput extends LoginInput {
  full_name: string;
  /** Omitted means attendee, the API's default. */
  role?: RegistrationRole;
}

export interface TokenPair {
  access_token: string;
  refresh_token: string;
  token_type: string;
}
