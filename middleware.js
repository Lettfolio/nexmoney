// Site-wide review gate (Stonebridge compliance review).
// Runs at the edge before every request; the gate page itself is exempted in code.
// Remove this file (and gate.html) to reopen the site to the public.
export const config = { matcher: '/(.*)' };

const CRED_HASH = 'e1c332f3f691c4f7549c6c8899d49930f25811c4594bb860054b3964945a1a48'; // sha256("username:password", both lowercased username

// Only the gate page itself is served without a valid cookie. Anchored to the
// EXACT path so lookalikes (/gateway, /gate-foo, /gate/anything) are still gated.
function isGatePage(p) {
  return p === '/gate' || p === '/gate.html';
}

export default async function middleware(request) {
  const url = new URL(request.url);
  if (isGatePage(url.pathname)) return; // the reviewer gate page always loads
  const m = (request.headers.get('cookie') || '').match(/(?:^|;\s*)nx_review=([^;]+)/);
  if (m) {
    try {
      const val = decodeURIComponent(m[1]);
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(val));
      const hex = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
      if (hex === CRED_HASH) return; // authenticated — continue to the site
    } catch (e) { /* fall through to gate */ }
  }
  url.pathname = '/gate';
  url.search = '';
  return Response.redirect(url.toString(), 302);
}
