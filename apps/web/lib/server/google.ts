import 'server-only';

/** Cookies that carry the Google sign-in state and PKCE verifier between the two BFF routes. */
export const G_STATE = 'hs_g_state';
export const G_VERIFIER = 'hs_g_verifier';
export const googleCookie = {
  httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax' as const, path: '/api/auth/google', maxAge: 600,
};
