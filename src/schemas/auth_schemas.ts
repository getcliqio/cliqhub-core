import { z } from 'zod';

export const signup_schema = z.object({
    username: z.string().min(1, 'username is required'),
    email: z.string().min(1, 'email is required'),
    password: z.string().min(1, 'password is required'),
});

/** Body for POST /internal/auth/authenticate_user. */
export const authenticate_user_schema = z.object({
    username: z.string().min(1, 'username is required'),
    password: z.string().min(1, 'password is required'),
});

export const issue_session_token_schema = z.object({
    user_id: z.string().uuid(),
});

export const revoke_session_token_schema = z.object({
    token: z.string().min(1, 'token is required'),
});
