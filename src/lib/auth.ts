import { supabase } from './supabase';

export async function getSession() {
  const { data: { session } } = await supabase.auth.getSession();
  return session;
}

export async function signIn(email: string, password: string) {
  return supabase.auth.signInWithPassword({ email, password });
}

export async function signOut() {
  return supabase.auth.signOut();
}

/** Toggle nav links and auth-only UI based on session state. */
export function initAuthUI() {
  function setAuthed(isAuthed: boolean) {
    document.querySelectorAll('[data-nav-auth]').forEach(el => {
      el.classList.toggle('hidden', !isAuthed);
    });
    document.querySelectorAll('[data-nav-guest]').forEach(el => {
      el.classList.toggle('hidden', isAuthed);
    });
    document.querySelectorAll('[data-auth-only]').forEach(el => {
      el.classList.toggle('hidden', !isAuthed);
    });
  }

  supabase.auth.getSession().then(({ data: { session } }) => {
    setAuthed(!!session);
  });

  supabase.auth.onAuthStateChange((_event, session) => {
    setAuthed(!!session);
  });

  document.getElementById('sign-out')?.addEventListener('click', async () => {
    await signOut();
    window.location.href = '/';
  });
}

/** Redirect to login if no session. Returns true when authenticated. */
export async function requireAuth(): Promise<boolean> {
  const session = await getSession();
  if (!session) {
    const redirect = encodeURIComponent(window.location.pathname + window.location.search);
    window.location.href = `/login?redirect=${redirect}`;
    return false;
  }
  return true;
}
