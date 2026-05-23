import { auth } from '../lib/firebase';

export async function authenticatedFetch(url: string, options: RequestInit = {}) {
  const user = auth.currentUser;
  const headers = new Headers(options.headers || {});

  if (user) {
    const idToken = await user.getIdToken();
    headers.set('Authorization', `Bearer ${idToken}`);
  }

  const response = await fetch(url, {
    ...options,
    headers,
  });

  return response;
}
