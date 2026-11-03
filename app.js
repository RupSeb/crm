import {
  html, render, useState, useEffect, useMemo, useRef, useCallback, createContext, useContext,
} from './vendor/preact-htm.js';
import DOMPurify from './vendor/purify.js';
import { db, DEMO } from './db.js';
import { STAGE_NAMES } from './demo.js';
import { APP_NAME } from './config.js';

const PALETTE = ['#7fa7c9', '#d98b4f', '#a9b4ae', '#b08fd6', '#6fb58f', '#d9be90', '#e07a7a'];

// ---------------------------------------------------------------------------
// Helfer
// ---------------------------------------------------------------------------
const Ctx = createContext(null);
const useApp = () => useContext(Ctx);

const ls = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* egal */ } },
};

// Zurück-Navigation: innerhalb der App per history.back(), nach einem
// Direktaufruf (z. B. Link aus einer Mail) auf die passende Übersicht.
let navigatedInApp = false;
addEventListener('hashchange', () => { navigatedInApp = true; });
function go(hash, replace = false) {
  if (replace) location.replace(hash);
  else location.hash = hash;
}
function back(fallback) {
  if (navigatedInApp) history.back();
  else go(fallback, true);
}

function useRoute() {
  const read = () => location.hash.slice(1) || '/heute';
  const [hash, setHash] = useState(read);
  useEffect(() => {
    const f = () => setHash(read());
    addEventListener('hashchange', f);
    return () => removeEventListener('hashchange', f);
  }, []);
  const [path, query = ''] = hash.split('?');
  return { parts: path.split('/').filter(Boolean), query: new URLSearchParams(query) };
}

function useMedia(q) {
  const [m, setM] = useState(() => matchMedia(q).matches);
  useEffect(() => {
    const mq = matchMedia(q);
    const f = () => setM(mq.matches);
    mq.addEventListener('change', f);
    return () => mq.removeEventListener('change', f);
  }, [q]);
  return m;
}

// Suche und Filter bleiben erhalten, wenn man zurück zur Liste kommt.
function useStored(key, init) {
  const [v, setV] = useState(() => { try { return sessionStorage.getItem(key) ?? init; } catch { return init; } });
  const set = useCallback((x) => {
    setV(x);
    try { sessionStorage.setItem(key, x); } catch { /* egal */ }
  }, [key]);
  return [v, set];
}

const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
function matches(q, ...fields) {
  const words = norm(q).trim().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = norm(fields.flat().join(' '));
  return words.every((w) => hay.includes(w));
}

const ts = (x) => Date.parse(x) || 0;
const byId = (list) => new Map(list.map((x) => [x.id, x]));
const bySort = (a, b) => a.sort - b.sort || a.id - b.id;
const byUpdatedDesc = (a, b) => ts(b.updated_at) - ts(a.updated_at);
const byCreatedDesc = (a, b) => ts(b.created_at) - ts(a.created_at);
const byHeldDesc = (a, b) => ts(b.held_at) - ts(a.held_at);
const byName = (a, b) => a.name.localeCompare(b.name, 'de');
const shortDate = (iso) => new Date(iso).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit' });
const monthLabel = (iso) => new Date(iso).toLocaleDateString('de-DE', { month: 'long', year: 'numeric' });

function relDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((day(new Date()) - day(d)) / 864e5);
  if (days <= 0) return 'heute';
  if (days === 1) return 'gestern';
  if (days < 7) return `vor ${days} Tagen`;
  return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit' });
}
const fullDate = (iso) => new Date(iso).toLocaleString('de-DE', {
  day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
});

// Dringlichkeit und Fälligkeit von Aufgaben
const PRIO = {
  hoch: { label: 'Hoch', rank: 0 },
  mittel: { label: 'Mittel', rank: 1 },
  niedrig: { label: 'Niedrig', rank: 3 },
};
const prioRank = (c) => PRIO[c.priority]?.rank ?? 2;
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const daysUntil = (due) => (due ? Math.round((Date.parse(due) - Date.parse(todayStr())) / 864e5) : null);
function dueInfo(due) {
  const days = daysUntil(due);
  if (days === null) return null;
  const date = new Date(due + 'T00:00');
  if (days < 0) return { label: days === -1 ? 'seit gestern fällig' : `seit ${-days} Tagen fällig`, cls: 'late' };
  if (days === 0) return { label: 'heute fällig', cls: 'today' };
  if (days === 1) return { label: 'morgen', cls: 'soon' };
  if (days < 7) return { label: date.toLocaleDateString('de-DE', { weekday: 'long' }), cls: 'soon' };
  return { label: date.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' }), cls: '' };
}

// Spaltenart aus dem Namen: To-Dos, Ongoing, Feedback von Anderen, Zukünftig, Erledigt
function stageKind(stage) {
  if (!stage) return null;
  if (stage.is_done) return 'done';
  const n = norm(stage.name);
  if (n.startsWith('to-do') || n.startsWith('todo')) return 'todo';
  if (n.startsWith('ongoing')) return 'doing';
  if (n.startsWith('feedback')) return 'waiting';
  if (n.startsWith('zukunft')) return 'later';
  return 'other';
}

function countLabels(list) {
  const m = new Map();
  list.forEach((x) => (x.labels || []).forEach((l) => m.set(l, (m.get(l) || 0) + 1)));
  return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'de'));
}

const safeUrl = (u) => (/^https?:\/\//i.test(u) ? u : 'https://' + u);
function waNumber(phone) {
  let d = phone.replace(/[^\d+]/g, '');
  if (d.startsWith('+')) d = d.slice(1);
  else if (d.startsWith('00')) d = d.slice(2);
  else if (d.startsWith('0')) d = '49' + d.slice(1);
  return d;
}

// Notizen kommen teils als HTML (Pipedrive, Meeting-Zusammenfassungen).
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});
const SAFE_HTML = {
  ALLOWED_TAGS: ['p', 'br', 'b', 'strong', 'i', 'em', 'u', 's', 'ul', 'ol', 'li', 'a', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'blockquote', 'div', 'span', 'hr', 'table', 'thead', 'tbody', 'tr', 'td', 'th', 'code', 'pre'],
  ALLOWED_ATTR: ['href'],
};
const sanitize = (h) => DOMPurify.sanitize(h || '', SAFE_HTML);
const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const textToHtml = (t) => escapeHtml(t.trim()).replace(/\n/g, '<br>');
function htmlToText(h) {
  const d = document.createElement('div');
  d.innerHTML = sanitize(String(h || '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h\d)>/gi, '\n'));
  return d.textContent.replace(/ /g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

function friendly(err) {
  const m = String(err?.message || err);
  if (/invalid login credentials/i.test(m)) return 'E-Mail oder Passwort stimmt nicht.';
  if (/totp|invalid.*code|code.*invalid|mfa/i.test(m)) return 'Der Code stimmt nicht. Bitte den aktuellen Code aus der App eingeben.';
  if (/email not confirmed/i.test(m)) return 'Bitte zuerst den Link in der Bestätigungsmail anklicken.';
  if (/already registered|already exists/i.test(m)) return 'Für diese E-Mail gibt es schon ein Konto. Bitte anmelden.';
  if (/password should be|weak password/i.test(m)) return 'Das Passwort ist zu kurz oder zu einfach.';
  if (/signups? not allowed|user not found/i.test(m)) return 'Diese E-Mail-Adresse ist nicht freigeschaltet.';
  if (/rate limit|too many|security purposes/i.test(m)) return 'Zu viele Versuche. Bitte ein paar Minuten warten.';
  if (/expired|invalid.*(otp|token)|token.*invalid/i.test(m)) return 'Der Code ist falsch oder abgelaufen.';
  if (/row-level security|permission denied/i.test(m)) return 'Keine Berechtigung. Ist deine E-Mail freigeschaltet?';
  if (/failed to fetch|networkerror|load failed/i.test(m)) return 'Keine Verbindung zum Server.';
  return m;
}

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------
const ICONS = {
  board: '<rect x="3.5" y="4" width="5" height="16" rx="1.5"/><rect x="10.5" y="4" width="5" height="11" rx="1.5"/><rect x="17.5" y="4" width="3.5" height="7" rx="1.5"/>',
  person: '<circle cx="12" cy="8" r="4"/><path d="M4 20c1.5-4 4.5-6 8-6s6.5 2 8 6"/>',
  building: '<rect x="4.5" y="3" width="15" height="18" rx="1.5"/><path d="M9 7h2M13 7h2M9 11h2M13 11h2M9 15h2M13 15h2M10.5 21v-3h3v3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  phone: '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 005 5L15 13l5 2v4a2 2 0 01-2 2A16 16 0 013 6a2 2 0 012-2"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>',
  chat: '<path d="M4 20l1.3-3.9A8 8 0 1112 20a8 8 0 01-3.9-1z"/>',
  link: '<path d="M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  next: '<path d="M9 5l7 7-7 7"/>',
  share: '<circle cx="9" cy="8" r="3.2"/><path d="M3.5 20a5.5 5.5 0 0111 0M16 5a3 3 0 010 6M20.5 20a5.5 5.5 0 00-3.5-5.1"/>',
  lock: '<rect x="5" y="11" width="14" height="9.5" rx="2"/><path d="M8.5 11V8a3.5 3.5 0 017 0v3"/>',
  file: '<path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z"/><path d="M14 3v5h5"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0013 0M12 17.5V21"/>',
  home: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><path d="M14 17l2 2 4-4"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="2"/><path d="M3.5 9.5h17M8 3v4M16 3v4"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z"/>',
  video: '<rect x="3" y="6" width="12.5" height="12" rx="2"/><path d="M15.5 10.5l5.5-3.5v10l-5.5-3.5"/>',
};
function Icon({ n }) {
  return html`<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" dangerouslySetInnerHTML=${{ __html: ICONS[n] }}></svg>`;
}

// Logo: goldene Knotenlinie
function BrandMark() {
  return html`<svg width="34" height="20" viewBox="0 0 34 20" aria-hidden="true">
    <path d="M5 15 L14 15 L20 5 L29 5" fill="none" stroke="#BF9969" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
    <circle cx="5" cy="15" r="3.2" fill="#BF9969" /><circle cx="29" cy="5" r="3.2" fill="#BF9969" />
  </svg>`;
}

// ---------------------------------------------------------------------------
// Start und Anmeldung
// ---------------------------------------------------------------------------
function App() {
  const route = useRoute();
  const [session, setSession] = useState(undefined);
  const [recovery, setRecovery] = useState(false);
  // Zwei-Faktor: null = wird geprüft, sonst { step: 'ok' | 'enroll' | 'challenge', factorId }
  const [mfa, setMfa] = useState(null);
  useEffect(() => {
    db.session().then(setSession).catch(() => setSession(null));
    db.onAuth((s, event) => {
      if (event === 'PASSWORD_RECOVERY') setRecovery(true);
      setSession(s ?? null);
    });
  }, []);
  useEffect(() => {
    setMfa(null);
    if (!session || recovery) return undefined;
    let alive = true;
    db.mfaState()
      .then((s) => {
        if (!alive) return;
        if (s.current === 'aal2') setMfa({ step: 'ok' });
        else if (s.verified.length) setMfa({ step: 'challenge', factorId: s.verified[0].id });
        else setMfa({ step: 'enroll' });
      })
      .catch(() => { if (alive) setMfa({ step: 'ok' }); });
    return () => { alive = false; };
    // Nur bei Wechsel des Nutzers neu prüfen. Am Token hängen hieße: bei jeder
    // stündlichen Erneuerung und nach neuem Faktor lädt die ganze App neu.
  }, [session ? (session.user?.id || session.user?.email || 'sitzung') : null, recovery]);

  if (session === undefined) return html`<div class="boot">Lädt …</div>`;
  if (!session || recovery) {
    return html`<${Login} start=${recovery ? 'newpass' : 'login'} onDone=${(s) => { setRecovery(false); setSession(s); }} />`;
  }
  if (!mfa) return html`<div class="boot">Lädt …</div>`;
  if (mfa.step !== 'ok') {
    return html`<${MfaScreen} step=${mfa.step} factorId=${mfa.factorId} onDone=${() => setMfa({ step: 'ok' })} />`;
  }
  if (route.parts[0] === 'claude-freigabe') {
    return html`<${ClaudeConsent} id=${route.query.get('authorization_id')} session=${session} />`;
  }
  return html`<${Main} session=${session} />`;
}

// Freigabe für Claude: Wer den CRM-Connector in Claude verbindet, landet nach der Anmeldung
// hier und erlaubt den Zugriff. Claude darf danach genau das, was die Person in der App darf.
function ClaudeConsent({ id, session }) {
  const [info, setInfo] = useState(null);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!id) { setMsg('Der Link ist unvollständig. Bitte die Verbindung in Claude neu starten.'); return; }
    db.oauthDetails(id)
      .then((d) => { if (d.redirect_url) location.replace(d.redirect_url); else setInfo(d); })
      .catch((e) => setMsg(friendly(e)));
  }, [id]);

  async function decide(approve) {
    setBusy(true); setMsg('');
    try {
      // Die Freigabe mit zweitem Faktor macht die Sitzung von Claude erst gültig (supabase/08_claude_online.sql)
      if (approve) await db.rpc('claude_freigeben', { auth_id: id, cid: info.client?.id || info.client?.client_id || '' });
      location.replace(await db.oauthDecide(id, approve));
    } catch (e) { setMsg(friendly(e)); setBusy(false); }
  }

  let target = '';
  try { target = new URL(info?.redirect_uri).host; } catch { /* ohne Ziel */ }
  return html`<div class="login-wrap">
    <div class="login-card">
      <div class="brand"><${BrandMark} />${APP_NAME}</div>
      <h1 class="login-title">Zugriff freigeben</h1>
      ${info ? html`
        <p><strong>${info.client?.name || info.client?.client_name || 'Ein Programm'}</strong> möchte in deinem Namen auf das CRM zugreifen.</p>
        <p class="muted small">Es darf dann genau das, was du in der App darfst: lesen, Deals anlegen und ändern, Notizen schreiben. Löschen geht auf diesem Weg nicht.</p>
        <p class="muted small">Angemeldet als ${session.user?.email}${target && html`, zurück an ${target}`}</p>
        <div class="consent-actions">
          <button class="btn primary" disabled=${busy} onClick=${() => decide(true)}>Erlauben</button>
          <button class="btn" disabled=${busy} onClick=${() => decide(false)}>Ablehnen</button>
        </div>`
    : !msg && html`<p class="muted small">Lädt …</p>`}
      ${msg && html`<p class="form-error" role="alert">${msg}</p>`}
      <div class="login-links"><button type="button" class="btn link sm" onClick=${() => db.signOut()}>Mit anderem Konto anmelden</button></div>
    </div>
  </div>`;
}

// Feld für den 6-stelligen Code mit Bestätigen-Knopf
function CodeField({ code, setCode, busy }) {
  return html`<label class="field"><span>Code aus der App</span>
      <input class="code-input" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required
        value=${code} onInput=${(e) => setCode(e.target.value.replace(/\D/g, ''))} /></label>
    <button class="btn primary full" disabled=${busy || code.length !== 6}>${busy ? 'Prüfe …' : 'Bestätigen'}</button>`;
}

// Neuen zweiten Faktor einrichten: Link fürs iPhone, QR-Code oder Schlüssel zum
// Kopieren (NordPass und andere Passwort-Manager). onDone bekommt die Faktor-ID.
function MfaSetup({ onDone }) {
  const [setup, setSetup] = useState(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [copied, setCopied] = useState(false);
  useEffect(() => { db.mfaEnroll().then(setSetup).catch((e) => setMsg(friendly(e))); }, []);

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setMsg('');
    try {
      await db.mfaVerify(setup.factorId, code.trim());
      await onDone(setup.factorId);
    } catch (err) { setMsg(friendly(err)); setCode(''); } finally { setBusy(false); }
  }
  async function copy() {
    try { await navigator.clipboard.writeText(setup.secret); setCopied(true); } catch { setCopied(false); }
  }

  return html`<form class="form" onSubmit=${submit}>
    ${!setup ? html`<p class="muted small">${msg ? '' : 'Lädt …'}</p>` : html`
      <p class="small"><strong>Passwort-Manager (z. B. NordPass):</strong> Schlüssel kopieren und im Eintrag fürs CRM als Zwei-Faktor-Code (2FA) einfügen.</p>
      <div class="mfa-key">
        <code class="mfa-secret">${setup.secret}</code>
        <button type="button" class="btn sm" onClick=${copy}>${copied ? 'Kopiert' : 'Kopieren'}</button>
      </div>
      <p class="small"><strong>iPhone ohne Passwort-Manager:</strong> <a href=${setup.uri}>hier tippen</a> und „Code hinzufügen“ bestätigen, dann liegt der Code in „Passwörter“.</p>
      <details class="more"><summary>QR-Code zum Scannen</summary>
        <img class="mfa-qr" src=${setup.qr} alt="QR-Code für die Authenticator-App" /></details>
      <p class="muted small">Danach den ersten Code aus der App hier eingeben.</p>
      <${CodeField} code=${code} setCode=${setCode} busy=${busy} />`}
    ${msg && html`<p class="form-error" role="alert">${msg}</p>`}
  </form>`;
}

// Zweiter Faktor bei der Anmeldung: einmal einrichten, danach jedes Mal den Code
function MfaScreen({ step, factorId, onDone }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setMsg('');
    try {
      await db.mfaVerify(factorId, code.trim());
      onDone();
    } catch (err) { setMsg(friendly(err)); setCode(''); } finally { setBusy(false); }
  }

  return html`<div class="login-wrap">
    <div class="login-card">
      <div class="brand"><${BrandMark} />${APP_NAME}</div>
      <h1 class="login-title">${step === 'enroll' ? 'Zwei-Faktor einrichten' : 'Bestätigungscode'}</h1>
      ${step === 'enroll' ? html`
        <p class="muted small">Zum Schutz deiner Daten fragt das CRM nach dem Passwort zusätzlich einen 6-stelligen Code ab. Den erzeugt dein Passwort-Manager oder eine Authenticator-App.</p>
        <${MfaSetup} onDone=${onDone} />`
    : html`<form class="form" onSubmit=${submit}>
        <p class="muted small">Gib den aktuellen 6-stelligen Code aus deinem Passwort-Manager oder deiner Authenticator-App ein.</p>
        <${CodeField} code=${code} setCode=${setCode} busy=${busy} />
      </form>
      ${msg && html`<p class="form-error" role="alert">${msg}</p>`}`}
      <div class="login-links"><button type="button" class="btn link sm" onClick=${() => db.signOut()}>Abmelden</button></div>
    </div>
  </div>`;
}

// Anmeldung mit E-Mail und Passwort. Konto anlegen geht einmalig über die
// Bestätigungsmail, ein vergessenes Passwort über den Link in der Mail.
function Login({ start, onDone }) {
  const [mode, setMode] = useState(start);
  const [email, setEmail] = useState(ls.get('crm-email') || '');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [info, setInfo] = useState('');
  const switchTo = (m) => { setMode(m); setMsg(''); setInfo(''); setPassword(''); };

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setMsg(''); setInfo('');
    const mail = email.trim();
    try {
      if (mode === 'login') {
        ls.set('crm-email', mail);
        onDone(await db.signIn(mail, password));
      } else if (mode === 'signup') {
        ls.set('crm-email', mail);
        const s = await db.signUp(mail, password);
        if (s) onDone(s);
        else { setInfo('Fast geschafft: Bitte den Link in der Bestätigungsmail anklicken und dich dann hier anmelden.'); setMode('login'); }
      } else if (mode === 'reset') {
        await db.resetPassword(mail);
        setInfo('Wir haben dir einen Link geschickt. Darüber legst du ein neues Passwort fest.');
      } else if (mode === 'newpass') {
        onDone(await db.setPassword(password));
      }
    } catch (err) { setMsg(friendly(err)); } finally { setBusy(false); }
  }

  const titles = { login: 'Anmelden', signup: 'Konto anlegen', reset: 'Passwort vergessen', newpass: 'Neues Passwort' };
  return html`<div class="login-wrap">
    <div class="login-card">
      <div class="brand"><${BrandMark} />${APP_NAME}</div>
      <form class="form" onSubmit=${submit}>
        <h1 class="login-title">${titles[mode]}</h1>
        ${mode !== 'newpass' && html`<label class="field"><span>E-Mail</span>
          <input type="email" autocomplete="email" required value=${email} onInput=${(e) => setEmail(e.target.value)} /></label>`}
        ${mode !== 'reset' && html`<label class="field"><span>Passwort</span>
          <input type="password" required minlength=${mode === 'login' ? 1 : 8}
            autocomplete=${mode === 'login' ? 'current-password' : 'new-password'}
            value=${password} onInput=${(e) => setPassword(e.target.value)} /></label>`}
        ${(mode === 'signup' || mode === 'newpass') && html`<p class="muted small">Mindestens 8 Zeichen.</p>`}
        <button class="btn primary full" disabled=${busy}>${busy ? 'Einen Moment …' : titles[mode]}</button>
        <div class="login-links">
          ${mode === 'login' && html`<button type="button" class="btn link sm" onClick=${() => switchTo('signup')}>Erstes Mal hier? Konto anlegen</button>
            <button type="button" class="btn link sm" onClick=${() => switchTo('reset')}>Passwort vergessen?</button>`}
          ${(mode === 'signup' || mode === 'reset') && html`<button type="button" class="btn link sm" onClick=${() => switchTo('login')}>Zurück zur Anmeldung</button>`}
        </div>
      </form>
      ${info && html`<p class="form-info" role="status">${info}</p>`}
      ${msg && html`<p class="form-error" role="alert">${msg}</p>`}
    </div>
  </div>`;
}

// ---------------------------------------------------------------------------
// Hauptansicht: lädt die Daten, Navigation, Routen
// ---------------------------------------------------------------------------
const TABS = [
  ['heute', 'Übersicht', 'home', '#/heute'],
  ['board', 'Board', 'board', '#/board'],
  ['kalender', 'Kalender', 'calendar', '#/kalender'],
  ['meetings', 'Meetings', 'mic', '#/meetings'],
  ['kontakte', 'Kontakte', 'person', '#/kontakte'],
  ['firmen', 'Firmen', 'building', '#/firmen'],
];
const TAB_OF = {
  heute: 'heute', board: 'board', karte: 'board', kalender: 'kalender', termin: 'kalender',
  meetings: 'meetings', meeting: 'meetings', kontakte: 'kontakte', kontakt: 'kontakte', firmen: 'firmen', firma: 'firmen',
};
// Meetings ohne die (langen) Zusammenfassungen laden, die kommen erst beim Öffnen.
const MEETING_COLUMNS = 'id,title,held_at,duration_min,project_id,extra_names,fireflies_id,created_at,updated_at';
// Termine ohne Beschreibung, die kommt erst beim Öffnen
const EVENT_COLUMNS = 'id,calendar_id,calendar_name,calendar_color,ical_uid,title,start_at,end_at,all_day,location,meet_url,html_link,attendees,organizer';

function Main({ session }) {
  const route = useRoute();
  const isMobile = useMedia('(max-width: 760px)');
  const [data, setData] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [toast, setToast] = useState(null);
  const lastParts = useRef(null);

  const fail = useCallback((e) => { console.error(e); setToast({ text: friendly(e) }); }, []);
  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(t);
  }, [toast]);

  const load = useCallback(async () => {
    try {
      const [projects, stages, organizations, persons, allCards, meetings, meeting_persons, events, event_persons,
        card_shares, role, users, project_shares, card_events, card_seen] = await Promise.all([
        ...['projects', 'stages', 'organizations', 'persons', 'cards'].map((t) => db.list(t)),
        db.list('meetings', {}, MEETING_COLUMNS),
        db.list('meeting_persons'),
        db.list('events', {}, EVENT_COLUMNS),
        db.list('event_persons'),
        db.list('card_shares').catch(() => []),
        db.rpc('my_role').catch(() => 'owner'),
        db.rpc('crm_users').catch(() => []),
        db.list('project_shares').catch(() => []),
        db.list('card_events').catch(() => []),
        db.list('card_seen').catch(() => []),
      ]);
      projects.sort(bySort);
      stages.sort(bySort);
      // Ein Gast bekommt von der Datenbank ohnehin nur geteilte Karten, das hier gilt für die Demo
      const me = (session?.user?.email || '').toLowerCase();
      const mine = new Set(card_shares.filter((x) => x.email.toLowerCase() === me).map((x) => x.card_id));
      const myProjects = new Set(project_shares.filter((x) => x.email.toLowerCase() === me).map((x) => x.project_id));
      const cards = role === 'gast' ? allCards.filter((c) => mine.has(c.id) || myProjects.has(c.project_id)) : allCards;
      setData({ projects, stages, organizations, persons, cards, meetings, meeting_persons, events, event_persons,
        card_shares, role: role || 'owner', users: users || [], project_shares, card_events, card_seen });
      setLoadError(null);
    } catch (e) {
      setLoadError(friendly(e));
    }
  }, []);

  // Beim Zurückkehren in die App neu laden, damit Handy und Rechner gleich sind.
  useEffect(() => {
    load();
    const onVisible = () => { if (document.visibilityState === 'visible') load(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [load]);

  const actions = useMemo(() => {
    const me = (session?.user?.email || '').toLowerCase();
    // Verlauf einer Karte neu holen, die Einträge schreibt die Datenbank selbst
    const reloadHistory = async (cardId) => {
      try {
        const rows = await db.list('card_events', { card_id: cardId });
        setData((d) => ({ ...d, card_events: [...d.card_events.filter((x) => x.card_id !== cardId), ...rows] }));
      } catch { /* Verlauf ist nicht kritisch */ }
    };
    const put = (table, row) => setData((d) => {
      const list = d[table];
      const exists = list.some((x) => x.id === row.id);
      return { ...d, [table]: exists ? list.map((x) => (x.id === row.id ? row : x)) : [...list, row] };
    });
    return {
      load,
      fail,
      // Kurze Meldung unten, optional mit „Rückgängig“
      notify(text, undo) { setToast({ text, undo }); },
      async save(table, row) {
        const { id, created_at: _c, updated_at: _u, ...fields } = row;
        try {
          const saved = id ? await db.update(table, id, fields) : await db.insert(table, fields);
          put(table, saved);
          if (table === 'cards') reloadHistory(saved.id);
          return saved;
        } catch (e) { fail(e); throw e; }
      },
      // Sofort anzeigen, dann speichern (z. B. Karte verschieben).
      async patch(table, id, fields) {
        const now = new Date().toISOString();
        setData((d) => ({ ...d, [table]: d[table].map((x) => (x.id === id ? { ...x, ...fields, updated_at: now } : x)) }));
        try {
          put(table, await db.update(table, id, fields));
          if (table === 'cards') reloadHistory(id);
        } catch (e) { fail(e); load(); }
      },
      reloadHistory,
      // Karte als gesehen markieren, damit „Neu“ verschwindet
      async markSeen(cardId) {
        const row = { card_id: cardId, email: me, seen_at: new Date().toISOString() };
        setData((d) => ({ ...d, card_seen: [...d.card_seen.filter((x) => !(x.card_id === cardId && x.email.toLowerCase() === me)), row] }));
        try { await db.upsert('card_seen', row, 'card_id,email'); } catch { /* nicht kritisch */ }
      },
      async remove(table, id) {
        try { await db.remove(table, id); await load(); } catch (e) { fail(e); throw e; }
      },
      // Löschen ohne Folgen für andere Tabellen, daher ohne Neuladen.
      async drop(table, id) {
        try {
          await db.remove(table, id);
          setData((d) => ({ ...d, [table]: d[table].filter((x) => x.id !== id) }));
        } catch (e) { fail(e); throw e; }
      },
      // Notizen hängen nicht im globalen Zustand; nach einer neuen Notiz
      // rutschen Aufgabe und Kontakt trotzdem nach oben.
      touched({ card_id: cardId, person_id: personId }) {
        const now = new Date().toISOString();
        if (cardId) reloadHistory(cardId);
        setData((d) => ({
          ...d,
          cards: d.cards.map((c) => (c.id === cardId ? { ...c, updated_at: now } : c)),
          persons: d.persons.map((p) => (p.id === personId ? { ...p, updated_at: now } : p)),
        }));
      },
      async addProject(name, sort) {
        try {
          const p = await db.insert('projects', { name, color: PALETTE[sort % PALETTE.length], sort });
          for (const [i, n] of STAGE_NAMES.entries()) {
            await db.insert('stages', { project_id: p.id, name: n, sort: i, is_done: n === 'Erledigt' });
          }
          await load();
          return p;
        } catch (e) { fail(e); throw e; }
      },
    };
  }, [load, fail]);

  const idx = useMemo(() => {
    if (!data) return null;
    const meetingsOf = new Map();
    const peopleOf = new Map();
    data.meeting_persons.forEach((l) => {
      if (!meetingsOf.has(l.person_id)) meetingsOf.set(l.person_id, []);
      meetingsOf.get(l.person_id).push(l.meeting_id);
      if (!peopleOf.has(l.meeting_id)) peopleOf.set(l.meeting_id, []);
      peopleOf.get(l.meeting_id).push(l);
    });
    // Derselbe Termin aus mehreren Kalendern (gleiche iCal-ID und Startzeit) nur einmal zeigen
    const seen = new Map();
    const calendarsOf = new Map();
    [...data.events].sort((a, b) => ts(a.start_at) - ts(b.start_at) || a.id - b.id).forEach((e) => {
      const k = (e.ical_uid || 'e' + e.id) + '|' + e.start_at;
      if (!seen.has(k)) seen.set(k, e);
      const first = seen.get(k);
      if (!calendarsOf.has(first.id)) calendarsOf.set(first.id, []);
      if (!calendarsOf.get(first.id).includes(e.calendar_name)) calendarsOf.get(first.id).push(e.calendar_name);
    });
    const events = [...seen.values()];
    const eventIds = new Map([...seen.entries()].map(([k, e]) => [k, e.id]));
    const eventOfRaw = new Map(data.events.map((e) => [e.id, eventIds.get((e.ical_uid || 'e' + e.id) + '|' + e.start_at)]));
    const eventsOf = new Map();
    const guestsOf = new Map();
    data.event_persons.forEach((l) => {
      const eid = eventOfRaw.get(l.event_id);
      if (!eid) return;
      if (!eventsOf.has(l.person_id)) eventsOf.set(l.person_id, new Set());
      eventsOf.get(l.person_id).add(eid);
      if (!guestsOf.has(eid)) guestsOf.set(eid, new Set());
      guestsOf.get(eid).add(l.person_id);
    });
    const sharesOf = new Map();
    data.card_shares.forEach((x) => {
      if (!sharesOf.has(x.card_id)) sharesOf.set(x.card_id, []);
      sharesOf.get(x.card_id).push(x);
    });
    // „claude“: Änderungen über den CRM-Zugang für Claude (tools/crm_mcp.py)
    const userName = new Map([...data.users.map((u) => [u.email.toLowerCase(), u.name]), ['claude', 'Claude']]);
    const projectSharesOf = new Map();
    data.project_shares.forEach((x) => {
      if (!projectSharesOf.has(x.project_id)) projectSharesOf.set(x.project_id, []);
      projectSharesOf.get(x.project_id).push(x);
    });
    const historyOf = new Map();
    [...data.card_events].sort((a, b) => ts(b.at) - ts(a.at) || b.id - a.id).forEach((e) => {
      if (!historyOf.has(e.card_id)) historyOf.set(e.card_id, []);
      historyOf.get(e.card_id).push(e);
    });
    const me = (session?.user?.email || '').toLowerCase();
    const seenAt = new Map(data.card_seen.filter((x) => x.email.toLowerCase() === me).map((x) => [x.card_id, ts(x.seen_at)]));
    // Neu: jemand anderes hat seit meinem letzten Öffnen etwas geändert
    // Was Claude im Auftrag des Eigentümers ändert, ist für ihn selbst nicht neu
    const byOther = (actor) => actor && actor.toLowerCase() !== me && !(data.role === 'owner' && actor.toLowerCase() === 'claude');
    const isNew = (c) => (historyOf.get(c.id) || []).some((e) => byOther(e.actor)
      && (!seenAt.has(c.id) || ts(e.at) > seenAt.get(c.id)));
    const mentionedMe = (c) => (historyOf.get(c.id) || []).some((e) => e.kind === 'erwaehnung'
      && (e.detail || '').toLowerCase() === me && (!seenAt.has(c.id) || ts(e.at) > seenAt.get(c.id)));
    // Wem gehört ein Projekt? Teilen, löschen und Deals herausschieben darf nur der Besitzer.
    // Zeilen ohne Besitzer (Demo) gehören mir.
    const project = byId(data.projects);
    const ownerOf = (pid) => (project.get(pid)?.owner || me).toLowerCase();
    const ownsProject = (pid) => ownerOf(pid) === me;
    const ownsRow = (row) => !row?.owner || row.owner.toLowerCase() === me;
    // Sieht jemand diese Karte? Besitzer des Projekts, direkt geteilt oder über ihr Projekt
    const visibleFor = (c, email) => ownerOf(c.project_id) === email
      || (sharesOf.get(c.id) || []).some((x) => x.email.toLowerCase() === email)
      || (projectSharesOf.get(c.project_id) || []).some((x) => x.email.toLowerCase() === email);
    return {
      sharesOf,
      projectSharesOf,
      historyOf,
      isNew,
      mentionedMe,
      visibleFor,
      ownerOf,
      ownsProject,
      ownsRow,
      userName,
      project,
      stage: byId(data.stages),
      org: byId(data.organizations),
      person: byId(data.persons),
      card: byId(data.cards),
      meeting: byId(data.meetings),
      event: byId(events),
      events,
      calendarsOf,
      eventsOf,
      guestsOf,
      meetingsOf,
      peopleOf,
    };
  }, [data]);

  async function logout() {
    if (DEMO && !confirm('Demo-Daten auf den Anfangszustand zurücksetzen?')) return;
    await db.signOut();
  }

  if (!data) {
    return html`<div class="boot">${loadError ? html`<div class="boot-error">
      <p>${loadError}</p>
      <button class="btn primary" onClick=${load}>Erneut versuchen</button>
      <button class="btn ghost" onClick=${logout}>Abmelden</button>
    </div>` : 'Lädt …'}</div>`;
  }

  const me = (session?.user?.email || '').toLowerCase();
  const isGuest = data.role === 'gast';
  const ctx = { ...data, idx, actions, isMobile, session, me, isGuest };
  const renderPage = ([s, id]) => {
    switch (s) {
      case 'board': return html`<${Board} projectId=${id} />`;
      case 'meetings': return html`<${MeetingsList} projectId=${id} />`;
      case 'kalender': return html`<${CalendarPage} />`;
      case 'kontakte': return html`<${PersonsList} />`;
      case 'kontakt': return html`<${PersonPage} key=${'p' + id} person=${idx.person.get(Number(id))} />`;
      case 'firmen': return html`<${OrgsList} />`;
      case 'firma': return html`<${OrgPage} key=${'o' + id} org=${idx.org.get(Number(id))} />`;
      default: return html`<${Overview} />`;
    }
  };
  // Aufgaben und Meetings öffnen sich über der Seite, von der man kommt.
  const [sec = 'heute', a, b] = route.parts;
  let bg = route.parts;
  let overlay = null;
  if (isGuest) {
    // Gast: nur die geteilten Karten, Einstellungen und sonst nichts
    bg = ['geteilt'];
    const newOk = a === 'neu' && (idx.projectSharesOf.get(Number(route.query.get('projekt'))) || []).length > 0;
    if (sec === 'karte' && (a !== 'neu' || newOk)) overlay = html`<${CardSheet} key=${'c' + a} id=${a} query=${route.query} />`;
    if (sec === 'einstellungen') overlay = html`<${SettingsSheet} key="settings" onLogout=${logout} />`;
  } else if (sec === 'karte') {
    const c = idx.card.get(Number(a));
    bg = lastParts.current || ['board', c?.project_id ?? route.query.get('projekt')];
    overlay = html`<${CardSheet} key=${'c' + a} id=${a} query=${route.query} />`;
  } else if (sec === 'meeting') {
    const m = idx.meeting.get(Number(a));
    bg = lastParts.current || ['meetings', m?.project_id];
    overlay = html`<${MeetingSheet} key=${'m' + a} meeting=${m} />`;
  } else if (sec === 'einstellungen') {
    bg = lastParts.current || ['heute'];
    overlay = html`<${SettingsSheet} key="settings" onLogout=${logout} />`;
  } else if (sec === 'termin' && a === 'neu') {
    bg = lastParts.current || ['kalender'];
    overlay = html`<${NewEventSheet} key=${'tn' + route.query} query=${route.query} />`;
  } else if (sec === 'termin') {
    bg = lastParts.current || ['kalender'];
    overlay = html`<${EventSheet} key=${'t' + a} event=${idx.event.get(Number(a))} />`;
  } else {
    lastParts.current = route.parts;
    const p = sec === 'kontakt' && idx.person.get(Number(a));
    const o = sec === 'firma' && idx.org.get(Number(a));
    if (sec === 'kontakte' && a === 'neu') overlay = html`<${PersonForm} key="neu" />`;
    if (p && b === 'bearbeiten') overlay = html`<${PersonForm} key=${'pe' + a} person=${p} />`;
    if (sec === 'firmen' && a === 'neu') overlay = html`<${OrgForm} key="neu" />`;
    if (o && b === 'bearbeiten') overlay = html`<${OrgForm} key=${'oe' + a} org=${o} />`;
  }
  const page = isGuest ? html`<${GuestHome} />` : renderPage(bg);
  const tab = isGuest ? 'geteilt' : TAB_OF[bg[0]] || 'heute';
  const tabs = isGuest ? [['geteilt', 'Geteilt', 'board', '#/geteilt']] : TABS;

  return html`<${Ctx.Provider} value=${ctx}>
    <div class=${'shell' + (isGuest ? ' guest' : '')}>
      <header class="topbar">
        <a class="brand" href=${isGuest ? '#/geteilt' : '#/heute'}><${BrandMark} />${APP_NAME}</a>
        <nav class="topnav">
          ${tabs.map(([key, label, , href]) => html`<a key=${key} href=${href} class=${tab === key ? 'on' : ''}>${label}</a>`)}
        </nav>
        <div class="topbar-end">
          ${DEMO && html`<span class="badge demo">Demo</span>`}
          <a class="icon-btn" href="#/einstellungen" title="Einstellungen" aria-label="Einstellungen"><${Icon} n="settings" /></a>
        </div>
      </header>
      <main class="main">${page}</main>
      <nav class="tabbar">
        ${tabs.map(([key, label, icon, href]) => html`<a key=${key} href=${href} class=${tab === key ? 'on' : ''}><${Icon} n=${icon} /><span>${label}</span></a>`)}
      </nav>
      ${overlay}
      ${toast && html`<div class="toast" role="alert" onClick=${() => setToast(null)}>
        <span>${toast.text}</span>
        ${toast.undo && html`<button class="toast-undo" onClick=${() => { toast.undo(); setToast(null); }}>Rückgängig</button>`}
      </div>`}
    </div>
  <//>`;
}

// ---------------------------------------------------------------------------
// Bausteine
// ---------------------------------------------------------------------------
function Sheet({ title, onClose, children }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    addEventListener('keydown', onKey);
    document.body.classList.add('noscroll');
    return () => {
      removeEventListener('keydown', onKey);
      document.body.classList.remove('noscroll');
    };
  }, []);
  return html`<div class="overlay" onMouseDown=${(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <div class="sheet" role="dialog" aria-modal="true" aria-label=${title}>
      <div class="sheet-head">
        <button class="icon-btn" onClick=${onClose} aria-label="Schließen"><${Icon} n="back" /></button>
        <h2>${title}</h2>
      </div>
      <div class="sheet-body">${children}</div>
    </div>
  </div>`;
}

// Farbschemas: Schlüssel für data-theme, Name, Hintergrund und Akzent fürs Farbmuster
const THEMES = [
  ['', 'Waldgrün', '#1c2723', '#bf9969'],
  ['anthrazit', 'Anthrazit', '#18191b', '#bf9969'],
  ['nacht', 'Nachtblau', '#121826', '#7aa2f7'],
  ['aubergine', 'Aubergine', '#1f1716', '#bf9969'],
  ['hell', 'Hell', '#faf9f6', '#354840'],
];
function applyTheme(key) {
  if (key) document.documentElement.dataset.theme = key;
  else delete document.documentElement.dataset.theme;
  const bg = (THEMES.find((t) => t[0] === key) || THEMES[0])[2];
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', bg);
}

function SettingsSheet({ onLogout }) {
  const { session, actions } = useApp();
  const [theme, setTheme] = useState(ls.get('crm-theme') || '');
  const [newFactor, setNewFactor] = useState(false);
  // Neuer Faktor bestätigt: alle älteren Faktoren entfernen, ihre Codes gelten dann nicht mehr
  async function factorDone(factorId) {
    await db.mfaRemoveOthers(factorId);
    setNewFactor(false);
    actions.notify('Neuer zweiter Faktor aktiv. Alte Codes gelten nicht mehr.');
  }
  const pick = (key) => {
    setTheme(key);
    ls.set('crm-theme', key);
    applyTheme(key);
  };
  return html`<${Sheet} title="Einstellungen" onClose=${() => back('#/heute')}>
    <section class="form">
      <div class="field"><span>Farbschema</span>
        <div class="themes">
          ${THEMES.map(([key, name, s1, s2]) => html`<button type="button" key=${name}
            class=${'theme-opt' + (theme === key ? ' on' : '')} onClick=${() => pick(key)}>
            <span class="swatch" style=${`--s1:${s1};--s2:${s2}`}></span>${name}</button>`)}
        </div>
        <p class="muted small">Gilt für dieses Gerät.</p>
      </div>
      <div class="field"><span>Konto</span>
        <p class="small">${DEMO ? 'Demo-Modus, Daten nur in diesem Browser' : `Angemeldet als ${session.user?.email || ''}, mit Zwei-Faktor-Anmeldung`}</p>
        <div class="form-actions">
          <button type="button" class="btn" onClick=${onLogout}>${DEMO ? 'Demo zurücksetzen' : 'Abmelden'}</button>
        </div>
      </div>
      <div class="field"><span>Zwei-Faktor</span>
        ${newFactor ? html`
          <p class="muted small">Neuen Faktor einrichten. Bis du den ersten Code bestätigst, gilt der bisherige weiter.</p>
          <${MfaSetup} onDone=${factorDone} />
          <div class="form-actions"><button type="button" class="btn link sm" onClick=${() => setNewFactor(false)}>Abbrechen</button></div>`
        : html`<p class="muted small">Für einen anderen Passwort-Manager, ein neues Handy oder wenn der alte Code weg ist.</p>
          <div class="form-actions"><button type="button" class="btn" onClick=${() => setNewFactor(true)}>Zweiten Faktor neu einrichten</button></div>`}
      </div>
    </section>
  <//>`;
}

function Avatar({ name, size, square }) {
  const initials = String(name || '').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  const hue = [...String(name || '')].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
  return html`<span class=${['avatar', size, square && 'sq'].filter(Boolean).join(' ')} style=${`--h:${hue}`}>${initials || '?'}</span>`;
}

function SearchBox({ value, onInput, placeholder }) {
  return html`<label class="search"><${Icon} n="search" />
    <input type="search" placeholder=${placeholder} value=${value} onInput=${(e) => onInput(e.target.value)} /></label>`;
}

function SortToggle({ value, onChange }) {
  return html`<div class="seg small" role="group" aria-label="Sortierung">
    <button class=${'seg-btn' + (value === 'neu' ? ' on' : '')} onClick=${() => onChange('neu')}>Neueste</button>
    <button class=${'seg-btn' + (value === 'az' ? ' on' : '')} onClick=${() => onChange('az')}>A–Z</button>
  </div>`;
}

function LabelFilter({ labels, value, onChange }) {
  return html`<div class="label-filter">
    <button class=${'chip toggle' + (!value ? ' on' : '')} onClick=${() => onChange('')}>Alle</button>
    ${labels.map(([l, n]) => html`<button key=${l} class=${'chip toggle' + (value === l ? ' on' : '')}
      onClick=${() => onChange(value === l ? '' : l)}>${l}<span class="chip-n">${n}</span></button>`)}
  </div>`;
}

function PageHead({ title, count, action }) {
  return html`<div class="page-head"><h1>${title}</h1>${count != null && html`<span class="count">${count}</span>`}
    ${action && html`<div class="page-action">${action}</div>`}</div>`;
}

function Fab({ href, label }) {
  return html`<a class="fab" href=${href} aria-label=${label} title=${label}><${Icon} n="plus" /></a>`;
}

function NotFound({ what, href }) {
  return html`<div class="empty-state"><h2>${what} nicht gefunden</h2><a class="btn" href=${href}>Zur Übersicht</a></div>`;
}

function Combobox({ items, value, onChange, label, sub, placeholder, onCreate, href }) {
  const selected = value != null ? items.find((i) => i.id === value) : null;
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef(null);
  const shown = useMemo(() => (q.trim()
    ? items.filter((i) => matches(q, label(i), (sub && sub(i)) || ''))
    : [...items].sort(byUpdatedDesc)).slice(0, 8), [q, items]);
  useEffect(() => { if (editing) inputRef.current?.focus(); }, [editing]);

  if (selected && !editing) {
    const s = sub && sub(selected);
    return html`<div class="combo-selected">
      ${href ? html`<a href=${href(selected)}>${label(selected)}</a>` : html`<span>${label(selected)}</span>`}
      ${s && html`<span class="muted ell">· ${s}</span>`}
      <span class="spacer"></span>
      <button type="button" class="btn ghost xs" onClick=${() => { setQ(''); setEditing(true); setOpen(true); }}>Ändern</button>
      <button type="button" class="icon-btn" aria-label="Entfernen" onClick=${() => onChange(null)}><${Icon} n="close" /></button>
    </div>`;
  }

  const options = [...shown.map((i) => ({ id: i.id, item: i })), ...(onCreate && q.trim() ? [{ create: true }] : [])];
  const choose = (id) => { onChange(id); setQ(''); setOpen(false); setEditing(false); };
  const create = async () => {
    const name = q.trim();
    if (!name) return;
    try { choose(await onCreate(name)); } catch { /* Meldung kommt über fail */ }
  };
  const pick = (o) => (o.create ? create() : choose(o.id));
  function onKey(e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive((x) => Math.min(x + 1, options.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((x) => Math.max(x - 1, 0)); }
    else if (e.key === 'Enter') { if (open && options[active]) { e.preventDefault(); pick(options[active]); } }
    else if (e.key === 'Escape' && open) { e.stopPropagation(); setOpen(false); setEditing(false); }
  }
  return html`<div class="combo">
    <input ref=${inputRef} type="text" value=${q} placeholder=${placeholder} autocomplete="off"
      onInput=${(e) => { setQ(e.target.value); setOpen(true); setActive(0); }}
      onFocus=${() => setOpen(true)}
      onBlur=${() => setTimeout(() => { setOpen(false); setEditing(false); }, 150)}
      onKeyDown=${onKey} />
    ${open && options.length > 0 && html`<ul class="combo-list" role="listbox">
      ${options.map((o, i) => html`<li key=${o.create ? 'neu' : o.id} class=${i === active ? 'on' : ''}
          onMouseDown=${(e) => { e.preventDefault(); pick(o); }}>
        ${o.create
    ? html`<span class="combo-new">+ „${q.trim()}“ neu anlegen</span>`
    : html`<span>${label(o.item)}</span>${sub && sub(o.item) && html`<span class="muted"> · ${sub(o.item)}</span>`}`}
      </li>`)}
    </ul>`}
  </div>`;
}

function MultiField({ label, type, values, onChange }) {
  const setAt = (i, v) => onChange(values.map((x, j) => (j === i ? v : x)));
  return html`<div class="field"><span>${label}</span>
    ${values.map((v, i) => html`<div class="multi-row" key=${i}>
      <input type=${type} value=${v} onInput=${(e) => setAt(i, e.target.value)} />
      ${values.length > 1 && html`<button type="button" class="icon-btn" aria-label="Entfernen"
        onClick=${() => onChange(values.filter((_, j) => j !== i))}><${Icon} n="close" /></button>`}
    </div>`)}
    <button type="button" class="btn link sm" onClick=${() => onChange([...values, ''])}>+ weitere</button>
  </div>`;
}

function LabelPicker({ all, value, onChange }) {
  const [q, setQ] = useState('');
  const options = [...new Set([...all, ...value])];
  const toggle = (l) => onChange(value.includes(l) ? value.filter((x) => x !== l) : [...value, l]);
  const add = () => {
    const l = q.trim();
    if (l && !value.includes(l)) onChange([...value, l]);
    setQ('');
  };
  return html`<div class="label-picker">
    ${options.map((l) => html`<button type="button" key=${l} class=${'chip toggle' + (value.includes(l) ? ' on' : '')}
      onClick=${() => toggle(l)}>${l}</button>`)}
    <input class="chip-input" placeholder="+ Label" value=${q} onInput=${(e) => setQ(e.target.value)}
      onKeyDown=${(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }} onBlur=${add} />
  </div>`;
}

function ContactActions({ phones = [], emails = [], website }) {
  if (!phones.length && !emails.length && !website) return null;
  return html`<div class="contact-actions">
    ${phones.map((ph) => html`<span class="btn-group" key=${'t' + ph}>
      <a class="btn" href=${'tel:' + ph.replace(/[^\d+]/g, '')}><${Icon} n="phone" />${ph}</a>
      <a class="btn" href=${'https://wa.me/' + waNumber(ph)} target="_blank" rel="noopener" title="WhatsApp" aria-label="WhatsApp"><${Icon} n="chat" /></a>
    </span>`)}
    ${emails.map((m) => html`<a class="btn" key=${'m' + m} href=${'mailto:' + m}><${Icon} n="mail" />${m}</a>`)}
    ${website && html`<a class="btn" href=${safeUrl(website)} target="_blank" rel="noopener"><${Icon} n="link" />${website.replace(/^https?:\/\//, '').replace(/\/$/, '')}</a>`}
  </div>`;
}

// ---------------------------------------------------------------------------
// Übersicht: was zu tun ist, worauf ich warte, letzte Meetings
// ---------------------------------------------------------------------------
// Team: was andere seit meinem letzten Blick geändert haben, und was bei anderen liegt
function TeamTile() {
  const { cards, idx, me, users } = useApp();
  if (users.length < 2) return null;
  const open = cards.filter((c) => !c.archived);
  const fresh = open.filter((c) => idx.isNew(c)).sort(byUpdatedDesc);
  const elsewhere = open.filter((c) => c.assignee && c.assignee.toLowerCase() !== me
    && stageKind(idx.stage.get(c.stage_id)) !== 'done').sort(byUpdatedDesc);
  return html`<section class="tile">
    <h2>Team</h2>
    <h3 class="group-normal">Neu seit deinem letzten Blick <span class="count">${fresh.length}</span></h3>
    ${fresh.slice(0, 8).map((c) => html`<${TodoRow} key=${'n' + c.id} card=${c} />`)}
    ${fresh.length === 0 && html`<p class="muted small">Keine Änderungen von anderen.</p>`}
    <h3 class="group-normal">Liegt bei anderen <span class="count">${elsewhere.length}</span></h3>
    ${elsewhere.slice(0, 8).map((c) => html`<${TodoRow} key=${'a' + c.id} card=${c} waiting />`)}
    ${elsewhere.length === 0 && html`<p class="muted small">Gerade liegt nichts bei anderen.</p>`}
  </section>`;
}

function Overview() {
  const { cards, meetings, idx, me } = useApp();
  const [showAll, setShowAll] = useState(false);
  const kind = (c) => stageKind(idx.stage.get(c.stage_id));
  // Was jemand anderem zugewiesen ist, steht nicht auf meiner Liste, sondern unter „Team“
  const open = cards.filter((c) => !c.archived && (!c.assignee || c.assignee.toLowerCase() === me));
  const todo = open.filter((c) => kind(c) === 'todo' || kind(c) === 'doing');
  const waiting = open.filter((c) => kind(c) === 'waiting').sort((a, b) => ts(a.updated_at) - ts(b.updated_at));

  // Gruppen wie auf einem Zettel: erst Fälliges, dann Dringendes, dann der Rest
  const groups = [
    ['Überfällig und heute', (c) => c.due_date && daysUntil(c.due_date) <= 0],
    ['Dringend', (c) => c.priority === 'hoch'],
    ['Diese Woche', (c) => c.due_date && daysUntil(c.due_date) < 7],
    ['Weitere', () => true],
  ];
  const left = new Set(todo.map((c) => c.id));
  const sections = groups.map(([title, test]) => {
    const list = todo.filter((c) => left.has(c.id) && test(c))
      .sort((a, b) => (a.due_date || '9').localeCompare(b.due_date || '9') || prioRank(a) - prioRank(b) || byUpdatedDesc(a, b));
    list.forEach((c) => left.delete(c.id));
    return [title, list];
  }).filter(([, list]) => list.length > 0);
  const recent = [...meetings].sort(byHeldDesc).slice(0, 6);
  const today = new Date().toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' });

  return html`<div class="page overview">
    <div class="page-head"><h1>Übersicht</h1><span class="muted">${today}</span></div>
    <div class="tiles">
      <section class="tile tile-main">
        <h2>Zu erledigen <span class="count">${todo.length}</span></h2>
        <${QuickAdd} />
        ${sections.map(([title, list]) => {
    const isRest = title === 'Weitere';
    const shown = isRest && !showAll ? list.slice(0, 8) : list;
    return html`<div class="todo-group" key=${title}>
            <h3 class=${'group-' + (title === 'Überfällig und heute' ? 'late' : title === 'Dringend' ? 'urgent' : 'normal')}>
              ${title} <span class="count">${list.length}</span></h3>
            ${shown.map((c) => html`<${TodoRow} key=${c.id} card=${c} />`)}
            ${isRest && list.length > 8 && html`<button class="btn link sm" onClick=${() => setShowAll(!showAll)}>
              ${showAll ? 'Weniger anzeigen' : `Alle ${list.length} anzeigen`}</button>`}
          </div>`;
  })}
        ${todo.length === 0 && html`<p class="muted small">Nichts offen. Neue Aufgaben oben eintippen.</p>`}
      </section>
      <div class="tile-side">
        <${TeamTile} />
        <${TodayEvents} />
        <section class="tile">
          <h2>Warte auf Rückmeldung <span class="count">${waiting.length}</span></h2>
          ${waiting.slice(0, 8).map((c) => html`<${TodoRow} key=${c.id} card=${c} waiting />`)}
          ${waiting.length > 8 && html`<a class="btn link sm" href="#/board">Alle auf dem Board</a>`}
          ${waiting.length === 0 && html`<p class="muted small">Gerade wartest du auf niemanden.</p>`}
        </section>
        <section class="tile">
          <h2>Letzte Meetings</h2>
          ${recent.map((m) => {
    const pr = idx.project.get(m.project_id);
    return html`<a key=${m.id} class="mini-card" href=${`#/meeting/${m.id}`} style=${`--pc:${pr?.color || '#888'}`}>
              <span class="mini-title">${m.title}</span>
              <span class="mini-meta"><span class="dot"></span>${shortDate(m.held_at)}${pr ? ` · ${pr.name}` : ''}</span>
            </a>`;
  })}
          ${recent.length === 0 && html`<p class="muted small">Noch keine Meetings.</p>`}
          <a class="btn link sm" href="#/meetings">Alle Meetings</a>
        </section>
      </div>
    </div>
  </div>`;
}

function QuickAdd() {
  const { projects, stages, actions } = useApp();
  const fallback = projects.find((p) => norm(p.name) === 'allgemein') || projects[0];
  const [text, setText] = useState('');
  const [prio, setPrio] = useState(null);
  const [due, setDue] = useState('');
  const [pid, setPid] = useState(() => {
    const saved = Number(ls.get('crm-quick-project'));
    return projects.some((p) => p.id === saved) ? saved : fallback?.id;
  });
  const [busy, setBusy] = useState(false);

  async function add(e) {
    e.preventDefault();
    const title = text.trim();
    const cols = stages.filter((s) => s.project_id === pid).sort(bySort);
    const stage = cols.find((s) => stageKind(s) === 'todo') || cols[0];
    if (!title || !stage) return;
    setBusy(true);
    try {
      await actions.save('cards', { title, project_id: pid, stage_id: stage.id, priority: prio, due_date: due || null });
      setText('');
      setPrio(null);
      setDue('');
      ls.set('crm-quick-project', String(pid));
    } catch { /* Meldung kommt über fail */ } finally { setBusy(false); }
  }

  if (!fallback) return null;
  return html`<form class="quick-add" onSubmit=${add}>
    <input class="qa-input" placeholder="Was steht an? Eintippen und Enter" value=${text} onInput=${(e) => setText(e.target.value)} />
    <div class="qa-row">
      <div class="seg small" role="group" aria-label="Dringlichkeit">
        ${Object.entries(PRIO).map(([k, p]) => html`<button type="button" key=${k}
          class=${'seg-btn prio-btn prio-' + k + (prio === k ? ' on' : '')} onClick=${() => setPrio(prio === k ? null : k)}>${p.label}</button>`)}
      </div>
      <input type="date" class="qa-date" value=${due} onInput=${(e) => setDue(e.target.value)} aria-label="Fällig am" title="Fällig am" />
      <select class="qa-project" value=${pid} onChange=${(e) => setPid(Number(e.target.value))} aria-label="Projekt">
        ${projects.map((p) => html`<option key=${p.id} value=${p.id}>${p.name}</option>`)}
      </select>
      <button class="btn primary sm" disabled=${busy || !text.trim()}>Hinzufügen</button>
    </div>
  </form>`;
}

function TodoRow({ card, waiting }) {
  const { idx, stages, actions } = useApp();
  const [done, setDone] = useState(false);
  const pr = idx.project.get(card.project_id);
  const person = idx.person.get(card.person_id);
  const meta = [pr?.name, person?.name, waiting ? `seit ${relDate(card.updated_at).replace(/^vor /, '')}` : ''].filter(Boolean).join(' · ');

  async function complete(e) {
    e.stopPropagation();
    const doneStage = stages.find((s) => s.project_id === card.project_id && s.is_done);
    if (!doneStage) return;
    const before = card.stage_id;
    setDone(true);
    await new Promise((r) => setTimeout(r, 350));
    await actions.patch('cards', card.id, { stage_id: doneStage.id });
    actions.notify(`„${card.title}“ erledigt`, () => actions.patch('cards', card.id, { stage_id: before }));
  }
  return html`<div class=${'todo' + (done ? ' done' : '')} role="link" tabindex="0"
      onClick=${() => go(`#/karte/${card.id}`)} onKeyDown=${(e) => { if (e.key === 'Enter') go(`#/karte/${card.id}`); }}
      style=${`--pc:${pr?.color || '#888'}`}>
    <button class="check" type="button" onClick=${complete} aria-label="Als erledigt markieren" title="Erledigt"><${Icon} n="check" /></button>
    <div class="todo-main">
      <div class="todo-title">${card.title}</div>
      <div class="todo-meta"><span class="dot"></span><span>${meta}</span><${CardBadges} card=${card} /><${TeamMarks} card=${card} /></div>
    </div>
  </div>`;
}

// ---------------------------------------------------------------------------
// Board
// ---------------------------------------------------------------------------
function Board({ projectId }) {
  const { projects, stages, cards, idx, isMobile, actions, session } = useApp();
  const [q, setQ] = useState('');
  const [dragId, setDragId] = useState(null);
  const [over, setOver] = useState(null);
  const [showAll, setShowAll] = useState({});
  const [mobileStage, setMobileStage] = useState(null);
  const project = idx.project.get(Number(projectId)) || idx.project.get(Number(ls.get('crm-project'))) || projects[0];
  const cols = useMemo(() => (project ? stages.filter((s) => s.project_id === project.id) : []), [stages, project]);
  const tabsRef = useRef(null);
  useEffect(() => {
    if (!project) return;
    ls.set('crm-project', String(project.id));
    tabsRef.current?.querySelector('.ptab.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [project?.id]);

  async function newProject() {
    const name = prompt('Name des neuen Projekts:');
    if (!name?.trim()) return;
    try {
      const p = await actions.addProject(name.trim(), projects.length);
      go(`#/board/${p.id}`);
    } catch { /* Meldung kommt über fail */ }
  }

  if (!project) {
    return html`<div class="empty-state">
      <h2>Noch keine Projekte</h2>
      <p class="muted">Lege ein Projekt an oder importiere deine Daten aus Pipedrive.</p>
      ${!DEMO && html`<p class="muted small">Angemeldet als ${session.user?.email}. Wenn hier Daten sein müssten:
        Ist diese Adresse in der Datenbank freigeschaltet?</p>`}
      <button class="btn primary" onClick=${newProject}>Projekt anlegen</button>
    </div>`;
  }

  const visible = cards.filter((c) => c.project_id === project.id && !c.archived
    && matches(q, c.title, idx.person.get(c.person_id)?.name || '', idx.org.get(c.org_id)?.name || ''));
  const byStage = new Map(cols.map((s) => [s.id, []]));
  visible.forEach((c) => byStage.get(c.stage_id)?.push(c));
  byStage.forEach((l) => l.sort(byUpdatedDesc));

  const move = (cardId, stageId) => {
    const c = idx.card.get(cardId);
    if (c && c.stage_id !== stageId) actions.patch('cards', cardId, { stage_id: stageId });
  };
  const newHref = (s) => `#/karte/neu?projekt=${project.id}&spalte=${s.id}`;

  const projectTabs = html`<div class="project-tabs" ref=${tabsRef}>
    ${projects.map((p) => html`<a key=${p.id} href=${`#/board/${p.id}`} class=${'ptab' + (p.id === project.id ? ' on' : '')}
      style=${`--pc:${p.color}`} title=${idx.ownsProject(p.id) ? '' : `Geteilt von ${idx.userName.get(idx.ownerOf(p.id)) || idx.ownerOf(p.id)}`}>
      <span class="dot"></span>${p.name}${!idx.ownsProject(p.id) && html` <${Icon} n="share" />`}</a>`)}
    <button class="ptab add" onClick=${newProject} title="Projekt anlegen" aria-label="Projekt anlegen">+</button>
  </div>`;
  const search = html`<${SearchBox} value=${q} onInput=${setQ} placeholder="Aufgaben durchsuchen" />`;
  const share = html`<${ProjectShare} project=${project} />`;

  const cardList = (s, list) => {
    const limit = s.is_done && !showAll[s.id] && !q ? 15 : Infinity;
    return html`
      ${list.slice(0, limit).map((c) => html`<${CardItem} key=${c.id} card=${c} dragging=${dragId === c.id}
        onDragStart=${() => setDragId(c.id)} onDragEnd=${() => { setDragId(null); setOver(null); }} />`)}
      ${list.length > limit && html`<button class="btn ghost sm full" onClick=${() => setShowAll({ ...showAll, [s.id]: true })}>
        Alle ${list.length} anzeigen</button>`}
      ${list.length === 0 && html`<div class="col-empty">${q ? 'Keine Treffer' : 'Keine Aufgaben'}</div>`}`;
  };

  if (isMobile) {
    const active = cols.find((s) => s.id === mobileStage) || cols[0];
    if (!active) return html`<div class="board-page">${projectTabs}<p class="muted pad">Dieses Projekt hat keine Spalten.</p></div>`;
    return html`<div class="board-page">
      ${projectTabs}
      ${search}
      ${share}
      <div class="stage-tabs">
        ${cols.map((s) => html`<button key=${s.id} class=${'stab' + (s.id === active.id ? ' on' : '')} onClick=${() => setMobileStage(s.id)}>
          ${s.name}<span class="count">${byStage.get(s.id).length}</span></button>`)}
      </div>
      <div class="mobile-list">${cardList(active, byStage.get(active.id))}</div>
      <${Fab} href=${newHref(active)} label="Neue Aufgabe" />
    </div>`;
  }

  return html`<div class="board-page">
    <div class="board-head">${projectTabs}${search}${share}</div>
    <div class="board" style=${`--cols:${cols.length}`}>
      ${cols.map((s) => html`<section key=${s.id} class=${'column' + (over === s.id ? ' over' : '')}
          onDragOver=${(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (over !== s.id) setOver(s.id); }}
          onDragLeave=${(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setOver(null); }}
          onDrop=${(e) => { e.preventDefault(); setOver(null); move(Number(e.dataTransfer.getData('text/plain')), s.id); }}>
        <header class="col-head">
          <span>${s.name}</span><span class="count">${byStage.get(s.id).length}</span>
          <a class="icon-btn" href=${newHref(s)} title="Aufgabe hinzufügen" aria-label="Aufgabe hinzufügen"><${Icon} n="plus" /></a>
        </header>
        <div class="col-body">${cardList(s, byStage.get(s.id))}</div>
      </section>`)}
    </div>
  </div>`;
}

// Ganzes Projekt teilen: alle Deals darin, auch künftige. Teilen darf nur, wem das Projekt gehört.
function ProjectShare({ project }) {
  const { users, project_shares, actions, isGuest, idx, me } = useApp();
  if (isGuest || !project) return null;
  if (!idx.ownsProject(project.id)) {
    const owner = idx.ownerOf(project.id);
    return html`<div class="project-share"><span class="muted small"><${Icon} n="share" /> Geteilt von ${idx.userName.get(owner) || owner}</span></div>`;
  }
  const guests = users.filter((u) => u.email !== me);
  if (!guests.length) return null;
  const rows = project_shares.filter((x) => x.project_id === project.id);
  const on = (u) => rows.find((x) => x.email.toLowerCase() === u.email);
  async function toggle(u) {
    const row = on(u);
    const rights = u.role === 'gast' ? 'und kann dort selbst Deals anlegen' : 'und kann dort alles bearbeiten und anlegen';
    if (!row && !confirm(`Ganzes Projekt „${project.name}“ mit ${u.name} teilen? ${u.name} sieht dann alle Deals darin, auch neue, ${rights}.`)) return;
    try {
      if (row) await actions.drop('project_shares', row.id);
      else await actions.save('project_shares', { project_id: project.id, email: u.email });
    } catch { /* fail */ }
  }
  return html`<div class="project-share">
    <span class="muted small"><${Icon} n="share" /> Projekt teilen</span>
    ${guests.map((u) => html`<button key=${u.email} type="button" class=${'chip toggle share' + (on(u) ? ' on' : '')}
      title=${on(u) ? 'Freigabe für das ganze Projekt aufheben' : 'Alle Deals dieses Projekts teilen'} onClick=${() => toggle(u)}>${u.name}</button>`)}
  </div>`;
}

function CardBadges({ card }) {
  const due = dueInfo(card.due_date);
  const p = PRIO[card.priority];
  if (!due && !p) return null;
  return html`<span class="badges">
    ${p && html`<span class=${'prio prio-' + card.priority}>${p.label}</span>`}
    ${due && html`<span class=${'due ' + due.cls}>${due.label}</span>`}
  </span>`;
}

// Kleine Hinweise an Karten: neu seit dem letzten Öffnen, zuständig ist jemand anderes
function TeamMarks({ card }) {
  const { idx, me, users } = useApp();
  if (users.length < 2) return null;
  const other = card.assignee && card.assignee.toLowerCase() !== me ? idx.userName.get(card.assignee.toLowerCase()) || card.assignee : null;
  return html`${idx.mentionedMe(card) && html`<span class="badge mention-badge" title="Du wurdest in einer Notiz erwähnt">@ dich</span>`}
    ${idx.isNew(card) && html`<span class="badge new" title="Jemand anderes hat seit deinem letzten Öffnen etwas geändert">Neu</span>`}
    ${other && html`<span class="badge assignee" title=${`Zuständig: ${other}`}>${other.split(' ')[0]}</span>`}`;
}

function CardItem({ card, dragging, onDragStart, onDragEnd }) {
  const { idx } = useApp();
  const person = idx.person.get(card.person_id);
  const org = idx.org.get(card.org_id);
  const meta = [person?.name, org?.name].filter(Boolean).join(' · ');
  return html`<a class=${'card' + (dragging ? ' dragging' : '')} href=${`#/karte/${card.id}`} draggable="true"
      onDragStart=${(e) => { e.dataTransfer.setData('text/plain', String(card.id)); e.dataTransfer.effectAllowed = 'move'; onDragStart(); }}
      onDragEnd=${onDragEnd}>
    <div class="card-title">${card.title}</div>
    ${meta && html`<div class="card-meta">${meta}</div>`}
    <div class="card-foot"><${CardBadges} card=${card} /><${TeamMarks} card=${card} />
      ${((idx.sharesOf.get(card.id) || []).length > 0 || (idx.projectSharesOf.get(card.project_id) || []).length > 0)
        && html`<span class="shared-mark" title="Geteilt"><${Icon} n="share" /></span>`}
      <span>${relDate(card.updated_at)}</span></div>
  </a>`;
}

// Dateien an einer Karte (Storage-Bucket „dateien“, Pfad karten/<id>/<zeit>-<name>)
const fileLabel = (name) => name.replace(/^\d{10,}-/, '').replace(/_/g, ' ');
// Storage erlaubt nur einfache Zeichen: Umlaute ausschreiben, Akzente weg, Leerzeichen als _
const safeFileName = (name) => name.replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/Ä/g, 'Ae')
  .replace(/Ö/g, 'Oe').replace(/Ü/g, 'Ue').replace(/ß/g, 'ss').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/\s+/g, '_').replace(/[^A-Za-z0-9._-]+/g, '-').slice(-120);
const fileSize = (n) => (n > 1e6 ? `${(n / 1e6).toFixed(1).replace('.', ',')} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);

function FilesPanel({ card }) {
  const { actions, isGuest, idx } = useApp();
  const [files, setFiles] = useState(null);
  const [busy, setBusy] = useState(false);
  const prefix = `karten/${card.id}`;
  const load = () => db.listFiles(prefix).then(setFiles).catch((e) => { actions.fail(e); setFiles([]); });
  useEffect(() => { load(); }, [card.id]);

  async function upload(e) {
    const list = [...e.target.files];
    e.target.value = '';
    if (!list.length) return;
    setBusy(true);
    try {
      for (const f of list) {
        if (f.size > 25e6) { actions.notify(`„${f.name}“ ist größer als 25 MB.`); continue; }
        await db.uploadFile(`${prefix}/${Date.now()}-${safeFileName(f.name)}`, f);
        await db.rpc('log_file', { cid: card.id, fname: f.name }).catch(() => {});
      }
      await load();
      actions.reloadHistory(card.id);
    } catch (err) { actions.fail(err); } finally { setBusy(false); }
  }
  async function open(f) {
    // Fenster sofort öffnen, sonst blockt das iPhone es nach dem Warten auf den Link
    const w = window.open('', '_blank');
    try {
      const url = await db.fileUrl(`${prefix}/${f.name}`);
      if (w) w.location.href = url; else location.href = url;
    } catch (e) { if (w) w.close(); actions.fail(e); }
  }
  async function del(f) {
    if (!confirm(`„${fileLabel(f.name)}“ löschen?`)) return;
    try { await db.removeFile(`${prefix}/${f.name}`); await load(); } catch (e) { actions.fail(e); }
  }

  return html`<section class="files">
    <h3>Dateien ${files && html`<span class="count">${files.length}</span>`}
      <label class=${'btn sm' + (busy ? ' disabled' : '')}><${Icon} n="plus" />${busy ? 'Lädt hoch …' : 'Datei hinzufügen'}
        <input type="file" multiple hidden disabled=${busy} onChange=${upload} /></label></h3>
    ${files === null ? html`<p class="muted small">Lädt …</p>`
    : files.length === 0 ? html`<p class="muted small">Noch keine Dateien. Exposé, Vertrag oder Fotos hier ablegen, bis 25 MB pro Datei.</p>`
      : files.map((f) => html`<div class="file-row" key=${f.name}>
        <button type="button" class="file-open" onClick=${() => open(f)}><${Icon} n="file" /><span class="ell">${fileLabel(f.name)}</span></button>
        <span class="muted small">${fileSize(f.metadata?.size || 0)} · ${shortDate(f.created_at)}</span>
        ${!isGuest && idx.ownsProject(card.project_id) && html`<button type="button" class="btn ghost xs danger" onClick=${() => del(f)}>Löschen</button>`}
      </div>`)}
  </section>`;
}

// Verlaufseintrag als Satz
function historyText(e, idx) {
  const d = e.detail;
  switch (e.kind) {
    case 'angelegt': return 'hat die Karte angelegt';
    case 'spalte': return `hat sie nach „${d}“ verschoben`;
    case 'dringlichkeit': return d ? `hat die Dringlichkeit auf „${PRIO[d]?.label || d}“ gesetzt` : 'hat die Dringlichkeit entfernt';
    case 'faellig': return d ? `hat „fällig am ${new Date(d + 'T12:00').toLocaleDateString('de-DE')}“ gesetzt` : 'hat die Fälligkeit entfernt';
    case 'zustaendig': return d ? `hat ${idx.userName.get(d.toLowerCase()) || d} zuständig gemacht` : 'hat die Zuständigkeit entfernt';
    case 'titel': return `hat den Titel geändert: „${d}“`;
    case 'projekt': return `hat sie ins Projekt „${d}“ verschoben`;
    case 'archiv': return d === 'ja' ? 'hat sie archiviert' : 'hat sie wiederhergestellt';
    case 'notiz': return 'hat eine Notiz geschrieben';
    case 'erwaehnung': return `hat ${idx.userName.get((d || '').toLowerCase()) || d} erwähnt`;
    case 'datei': return `hat „${d}“ hochgeladen`;
    default: return e.kind;
  }
}

function CardSheet({ id, query }) {
  const { idx, projects, stages, persons, organizations, actions, isGuest, users, me, project_shares } = useApp();
  const isNew = id === 'neu';
  const card = isNew ? null : idx.card.get(Number(id));
  // Mails zum Deal: vom Kontakt, ohne Kontakt von allen Kontakten der Firma. Gäste sehen nie Mails.
  // Der eigene Kontakt bleibt außen vor, an ihm hängt sonst jede eigene Mail.
  const myName = norm(users.find((u) => u.email?.toLowerCase() === me)?.name);
  const notMe = (p) => p && !(myName && norm(p.name) === myName) && !(p.emails || []).some((e) => e.toLowerCase() === me);
  const mailPeople = (!card || isGuest ? [] : card.person_id ? [idx.person.get(card.person_id)]
    : card.org_id ? persons.filter((p) => p.org_id === card.org_id) : []).filter(notMe).map((p) => p.id);
  const firstStage = (pid) => stages.filter((s) => s.project_id === pid).sort(bySort)[0]?.id ?? null;
  const [form, setForm] = useState(() => {
    if (card) {
      const { title, project_id, stage_id, person_id, org_id, priority, due_date, assignee } = card;
      return { title, project_id, stage_id, person_id, org_id, priority: priority ?? null, due_date: due_date ?? null, assignee: assignee ?? null };
    }
    const pid = Number(query.get('projekt')) || Number(ls.get('crm-project')) || projects[0]?.id;
    const person = idx.person.get(Number(query.get('kontakt')));
    return {
      title: '',
      project_id: pid,
      stage_id: Number(query.get('spalte')) || firstStage(pid),
      person_id: person?.id ?? null,
      org_id: Number(query.get('firma')) || person?.org_id || null,
      priority: null,
      due_date: null,
      assignee: null,
    };
  });
  const [busy, setBusy] = useState(false);
  const titleRef = useRef(null);
  useEffect(() => { if (isNew) titleRef.current?.focus(); }, []);
  // Öffnen zählt als gesehen, damit „Neu“ verschwindet
  useEffect(() => { if (card) actions.markSeen(card.id); }, [card?.id]);
  const close = () => back(isGuest ? '#/geteilt' : card ? `#/board/${card.project_id}` : '#/board');

  if (!isNew && !card) {
    return html`<${Sheet} title="Aufgabe" onClose=${close}><p class="muted">Diese Aufgabe gibt es nicht mehr.</p><//>`;
  }

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const fields = ['title', 'project_id', 'stage_id', 'person_id', 'org_id', 'priority', 'due_date', 'assignee'];
  const fromMeeting = card?.meeting_id ? idx.meeting.get(card.meeting_id) : null;
  const dirty = !card || fields.some((k) => (form[k] ?? null) !== (card[k] ?? null));
  const projStages = stages.filter((s) => s.project_id === form.project_id).sort(bySort);

  function changeProject(pid) {
    const same = stages.find((s) => s.project_id === pid && s.name === idx.stage.get(form.stage_id)?.name);
    setForm((f) => ({ ...f, project_id: pid, stage_id: same?.id ?? firstStage(pid) }));
  }
  function pickStage(sid) {
    set('stage_id', sid);
    // Spalte wechseln speichert sofort, solange das Projekt gleich bleibt.
    if (card && form.project_id === card.project_id) actions.patch('cards', card.id, { stage_id: sid });
  }
  function pickPerson(pid) {
    const p = idx.person.get(pid);
    setForm((f) => ({ ...f, person_id: pid, org_id: f.org_id || p?.org_id || null }));
  }
  async function submit(e) {
    e.preventDefault();
    if (!form.title.trim()) return;
    setBusy(true);
    try {
      const saved = await actions.save('cards', { ...(card ? { id: card.id } : {}), ...form, title: form.title.trim() });
      if (!card) go(`#/karte/${saved.id}`, true);
    } catch { /* Meldung kommt über fail */ } finally { setBusy(false); }
  }
  async function archive() {
    try { await actions.save('cards', { id: card.id, archived: !card.archived }); } catch { /* fail */ }
  }
  async function del() {
    if (!confirm('Aufgabe mit allen Notizen löschen?')) return;
    try { await actions.remove('cards', card.id); close(); } catch { /* fail */ }
  }
  // Teilen mit Gästen (z. B. Geschäftspartner): sie sehen nur diese Karte
  // Teilen, löschen und in andere Projekte schieben darf nur, wem das Projekt des Deals gehört
  const ownProject = !card || idx.ownsProject(card.project_id);
  const guests = users.filter((u) => u.email !== me);
  const shares = card ? idx.sharesOf.get(card.id) || [] : [];
  async function toggleShare(u) {
    const row = shares.find((x) => x.email.toLowerCase() === u.email);
    try {
      if (row) await actions.drop('card_shares', row.id);
      else await actions.save('card_shares', { card_id: card.id, email: u.email });
    } catch { /* fail */ }
  }
  const viaProject = (u) => (idx.projectSharesOf.get(form.project_id) || []).some((x) => x.email.toLowerCase() === u.email);
  const sharedNames = [...new Set([...shares.map((x) => x.email.toLowerCase()), ...guests.filter(viaProject).map((u) => u.email)])]
    .map((e) => idx.userName.get(e) || e);
  // Zuständig: wird sofort gespeichert. Bekommt jemand eine Karte, die er nicht sieht, wird sie mit ihm geteilt.
  async function pickAssignee(email) {
    set('assignee', email);
    if (!card) return;
    await actions.patch('cards', card.id, { assignee: email });
    const u = users.find((x) => x.email === email);
    if (!isGuest && ownProject && u && !idx.visibleFor(card, email)) {
      try {
        await actions.save('card_shares', { card_id: card.id, email });
        actions.notify(`${u.name} sieht diese Karte jetzt auch.`);
      } catch { /* fail */ }
    }
  }
  const history = card ? idx.historyOf.get(card.id) || [] : [];
  const guestProjects = new Set(project_shares.filter((x) => x.email.toLowerCase() === me).map((x) => x.project_id));
  const person = idx.person.get(form.person_id);
  const org = idx.org.get(form.org_id);

  return html`<${Sheet} title=${isNew ? 'Neue Aufgabe' : 'Aufgabe'} onClose=${close}>
    <form class="form" onSubmit=${submit}>
      ${card?.archived && html`<div class="notice">Diese Aufgabe ist archiviert und erscheint nicht auf dem Board.</div>`}
      ${isGuest && !isNew ? html`<h2 class="ev-sheet-title">${form.title}</h2>
        <p class="meta">${idx.project.get(form.project_id)?.name}</p>` : html`
      <label class="field"><span>Titel</span>
        <textarea ref=${titleRef} rows="2" class="title-input" value=${form.title} placeholder="Was ist zu tun?"
          onInput=${(e) => set('title', e.target.value)}
          onKeyDown=${(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.target.form.requestSubmit(); } }}></textarea></label>
      ${card && !ownProject && html`<p class="muted small"><${Icon} n="share" /> Geteilt von ${idx.userName.get(idx.ownerOf(card.project_id)) || idx.ownerOf(card.project_id)}</p>`}
      ${card && ownProject && guests.length > 0 && html`<div class="field share-field"><span>Teilen</span>
        <div class="chips">${guests.map((u) => html`<button type="button" key=${u.email}
          class=${'chip toggle share' + (shares.some((x) => x.email.toLowerCase() === u.email) || viaProject(u) ? ' on' : '')}
          disabled=${viaProject(u)} title=${viaProject(u) ? 'Über das ganze Projekt geteilt' : ''}
          onClick=${() => toggleShare(u)}><${Icon} n="share" />${u.name}${viaProject(u) ? ' (Projekt)' : ''}</button>`)}</div>
        <p class="muted small">${sharedNames.length
    ? `${sharedNames.join(', ')} sieht diese Karte und ihre Notizen, außer denen mit Schloss. Mails, Meetings und andere Karten nicht.`
    : 'Nur du siehst diese Karte. Antippen, um sie zu teilen.'}</p>
      </div>`}
      <label class="field"><span>Projekt</span>
        <select value=${form.project_id} onChange=${(e) => changeProject(Number(e.target.value))}>
          ${projects.filter((p) => (isGuest ? guestProjects.has(p.id) : ownProject || p.id === card.project_id))
            .map((p) => html`<option key=${p.id} value=${p.id}>${p.name}</option>`)}
        </select></label>`}
      <div class="field"><span>Spalte</span>
        <div class="seg wrap">${projStages.map((s) => html`<button type="button" key=${s.id}
          class=${'seg-btn' + (s.id === form.stage_id ? ' on' : '')} onClick=${() => pickStage(s.id)}>${s.name}</button>`)}</div>
      </div>
      <div class="field-row">
        <div class="field"><span>Dringlichkeit</span>
          <div class="seg">${Object.entries(PRIO).map(([k, p]) => html`<button type="button" key=${k}
            class=${'seg-btn prio-btn prio-' + k + (form.priority === k ? ' on' : '')}
            onClick=${() => set('priority', form.priority === k ? null : k)}>${p.label}</button>`)}</div>
        </div>
        <label class="field"><span>Fällig am</span>
          <input type="date" value=${form.due_date || ''} onInput=${(e) => set('due_date', e.target.value || null)} /></label>
      </div>
      ${users.length > 1 && html`<div class="field"><span>Zuständig</span>
        <div class="seg wrap">
          <button type="button" class=${'seg-btn' + (!form.assignee ? ' on' : '')} onClick=${() => pickAssignee(null)}>Niemand</button>
          ${users.map((u) => html`<button type="button" key=${u.email} class=${'seg-btn' + (form.assignee === u.email ? ' on' : '')}
            onClick=${() => pickAssignee(u.email)}>${u.email === me ? 'Ich' : u.name}</button>`)}
        </div></div>`}
      ${fromMeeting && html`<p class="meta">Aus dem Meeting <a href=${`#/meeting/${fromMeeting.id}`}>${fromMeeting.title}</a> vom ${shortDate(fromMeeting.held_at)}</p>`}
      ${isGuest ? html`${(person || org) && html`<div class="field"><span>Kontakt</span>
        <p class="small">${[person?.name, org?.name].filter(Boolean).join(' · ')}</p>
        ${person && html`<${ContactActions} phones=${person.phones} emails=${person.emails} />`}</div>`}` : html`
      <div class="field"><span>Kontakt</span>
        <${Combobox} items=${persons} value=${form.person_id} onChange=${pickPerson} placeholder="Kontakt suchen oder neu anlegen"
          label=${(p) => p.name} sub=${(p) => idx.org.get(p.org_id)?.name} href=${(p) => `#/kontakt/${p.id}`}
          onCreate=${async (name) => (await actions.save('persons', { name })).id} /></div>
      <div class="field"><span>Firma</span>
        <${Combobox} items=${organizations} value=${form.org_id} onChange=${(v) => set('org_id', v)} placeholder="Firma suchen oder neu anlegen"
          label=${(o) => o.name} href=${(o) => `#/firma/${o.id}`}
          onCreate=${async (name) => (await actions.save('organizations', { name })).id} /></div>`}
      <div class="form-actions">
        <button class="btn primary" disabled=${busy || !dirty || !form.title.trim()}>${isNew ? 'Anlegen' : 'Speichern'}</button>
        ${card && !isGuest && html`<span class="spacer"></span>
          <button type="button" class="btn ghost" onClick=${archive}>${card.archived ? 'Wiederherstellen' : 'Archivieren'}</button>
          ${ownProject && html`<button type="button" class="btn ghost danger" onClick=${del}>Löschen</button>`}`}
      </div>
      ${card && html`<p class="meta">Angelegt ${fullDate(card.created_at)} · geändert ${relDate(card.updated_at)}</p>`}
      ${history.length > 0 && html`<details class="more history"><summary>Verlauf <span class="count">${history.length}</span></summary>
        ${history.map((e) => html`<div class="hist-row" key=${e.id}>
          <span class="muted">${fullDate(e.at)}</span> <strong>${!e.actor ? 'System' : e.actor.toLowerCase() === me ? 'Du' : idx.userName.get(e.actor.toLowerCase()) || e.actor}</strong> ${historyText(e, idx)}</div>`)}
      </details>`}
    </form>
    ${card && html`<${FilesPanel} card=${card} />`}
    ${card && html`<${NotesPanel} filter=${{ card_id: card.id }}
      defaults=${{ card_id: card.id, person_id: card.person_id, org_id: card.org_id }} />`}
    ${mailPeople.length > 0 && html`<${EmailsPanel} personIds=${mailPeople} />`}
  <//>`;
}

function CardsPanel({ cards, newHref }) {
  const { idx } = useApp();
  const [showArchived, setShowArchived] = useState(false);
  const isDone = (c) => (idx.stage.get(c.stage_id)?.is_done ? 1 : 0);
  const sorted = [...cards].sort((a, b) => isDone(a) - isDone(b) || byUpdatedDesc(a, b));
  const active = sorted.filter((c) => !c.archived);
  const archivedCount = cards.length - active.length;
  const list = showArchived ? sorted : active;
  return html`<section class="panel">
    <h3>Aufgaben <span class="count">${active.length}</span>
      <a class="icon-btn" href=${newHref} title="Aufgabe hinzufügen" aria-label="Aufgabe hinzufügen"><${Icon} n="plus" /></a></h3>
    ${list.map((c) => {
    const st = idx.stage.get(c.stage_id);
    const pr = idx.project.get(c.project_id);
    return html`<a key=${c.id} class=${'mini-card' + (c.archived ? ' archived' : '') + (st?.is_done ? ' done' : '')}
        href=${`#/karte/${c.id}`} style=${`--pc:${pr?.color || '#888'}`}>
      <span class="mini-title">${c.title}</span>
      <span class="mini-meta"><span class="dot"></span>${pr?.name} · ${st?.name}${c.archived ? ' · archiviert' : ''}</span>
    </a>`;
  })}
    ${list.length === 0 && html`<p class="muted small">Keine Aufgaben.</p>`}
    ${archivedCount > 0 && html`<button class="btn link sm" onClick=${() => setShowArchived(!showArchived)}>
      ${showArchived ? 'Archiv ausblenden' : `Archiv anzeigen (${archivedCount})`}</button>`}
  </section>`;
}

// Startseite für Gäste: was ihnen zugewiesen ist und alle geteilten Karten nach Projekten
function GuestHome() {
  const { cards, idx, users, me, project_shares } = useApp();
  const list = cards.filter((c) => !c.archived).sort(byUpdatedDesc);
  const owners = users.filter((u) => u.role === 'owner').map((u) => u.name).join(', ');
  const mine = list.filter((c) => idx.mentionedMe(c)
    || (c.assignee && c.assignee.toLowerCase() === me && stageKind(idx.stage.get(c.stage_id)) !== 'done'));
  const fullProjects = new Set(project_shares.filter((x) => x.email.toLowerCase() === me).map((x) => x.project_id));
  const byProject = new Map();
  list.forEach((c) => {
    if (!byProject.has(c.project_id)) byProject.set(c.project_id, []);
    byProject.get(c.project_id).push(c);
  });
  fullProjects.forEach((pid) => { if (!byProject.has(pid)) byProject.set(pid, []); });
  const row = (c) => {
    const st = idx.stage.get(c.stage_id);
    const pr = idx.project.get(c.project_id);
    const person = idx.person.get(c.person_id);
    return html`<a key=${c.id} class=${'mini-card' + (st?.is_done ? ' done' : '')} href=${`#/karte/${c.id}`} style=${`--pc:${pr?.color || '#888'}`}>
      <span class="mini-title">${c.title}</span>
      <span class="mini-meta"><span class="dot"></span>${[st?.name, person?.name].filter(Boolean).join(' · ')} · ${relDate(c.updated_at)}</span>
      <span class="badges"><${CardBadges} card=${c} /><${TeamMarks} card=${c} /></span>
    </a>`;
  };
  return html`<div class="page">
    <${PageHead} title="Mit dir geteilt" count=${list.length} />
    ${owners && html`<p class="muted small">Von ${owners}. Du kannst Notizen schreiben und Spalte, Dringlichkeit, Fälligkeit und Zuständigkeit ändern. In ganz geteilten Projekten kannst du auch Deals anlegen.</p>`}
    ${mine.length > 0 && html`<section class="panel"><h3>Für dich <span class="count">${mine.length}</span></h3>${mine.map(row)}</section>`}
    ${byProject.size === 0
    ? html`<div class="empty-state"><h2>Noch nichts geteilt</h2><p class="muted">Sobald ein Deal mit dir geteilt wird, steht er hier.</p></div>`
    : [...byProject.entries()].map(([pid, cs]) => html`<section class="panel" key=${pid}>
        <h3>${idx.project.get(pid)?.name || 'Projekt'} <span class="count">${cs.length}</span>
          ${fullProjects.has(pid) && html`<a class="icon-btn" href=${`#/karte/neu?projekt=${pid}`} title="Deal anlegen" aria-label="Deal anlegen"><${Icon} n="plus" /></a>`}</h3>
        ${cs.map(row)}
        ${cs.length === 0 && html`<p class="muted small">Noch keine Deals.</p>`}
      </section>`)}
  </div>`;
}

// ---------------------------------------------------------------------------
// Notizen
// ---------------------------------------------------------------------------
// @Erwähnungen: „@Vorname“ oder „@Vorname Nachname“ eines CRM-Nutzers
const escapeRe = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function mentionPattern(u) {
  const full = u.name.trim();
  const first = full.split(/\s+/)[0];
  return new RegExp(`@(${escapeRe(full)}|${escapeRe(first)})(?![\\p{L}])`, 'iu');
}
function findMentions(text, users, me) {
  return users.filter((u) => u.email !== me && mentionPattern(u).test(text)).map((u) => u.email);
}
// Erwähnungen in einer (schon bereinigten) Notiz hervorheben
function highlightMentions(htmlText, users) {
  return users.reduce((out, u) => out.replace(new RegExp(mentionPattern(u).source, 'giu'),
    (m) => `<span class="mention">${m}</span>`), htmlText);
}

function NotesPanel({ filter, defaults }) {
  const { actions, isMobile, isGuest, users, me, idx } = useApp();
  const [notes, setNotes] = useState(null);
  const [text, setText] = useState('');
  const [priv, setPriv] = useState(false);
  const [busy, setBusy] = useState(false);
  const textRef = useRef(null);
  const others = users.filter((u) => u.email !== me);
  const insertMention = (u) => {
    const tag = `@${u.name.split(/\s+/)[0]} `;
    setText((t) => (t && !/\s$/.test(t) ? `${t} ${tag}` : `${t}${tag}`));
    textRef.current?.focus();
  };
  const key = JSON.stringify(filter);

  useEffect(() => {
    let alive = true;
    setNotes(null);
    db.list('notes', filter)
      // Für Gäste filtert die Datenbank Notizen mit Schloss heraus, das hier gilt für die Demo
      .then((n) => { if (alive) setNotes(n.filter((x) => !isGuest || !x.private).sort(byCreatedDesc)); })
      .catch((e) => { actions.fail(e); if (alive) setNotes([]); });
    return () => { alive = false; };
  }, [key]);

  async function add(e) {
    e.preventDefault();
    if (!text.trim()) return;
    setBusy(true);
    try {
      const isPrivate = !isGuest && priv;
      // Notizen mit Schloss erwähnen niemanden, die sieht ja nur, wer sie schreibt
      const mentions = filter.card_id && !isPrivate ? findMentions(text, users, me) : [];
      const n = await db.insert('notes', { ...defaults, content: textToHtml(text), source: 'manual', private: isPrivate, mentions });
      setNotes((l) => [n, ...(l || [])]);
      setText('');
      setPriv(false);
      // Wird jemand erwähnt, der die Karte nicht sieht, bekommt er sie geteilt (wenn mir das Projekt gehört)
      const card = idx.card.get(filter.card_id);
      for (const email of mentions) {
        const u = users.find((x) => x.email === email);
        if (card && !isGuest && u && idx.ownsProject(card.project_id) && !idx.visibleFor(card, email)) {
          await actions.save('card_shares', { card_id: card.id, email });
          actions.notify(`${u.name} sieht diese Karte jetzt auch.`);
        }
      }
      actions.touched(defaults);
    } catch (err) { actions.fail(err); } finally { setBusy(false); }
  }
  async function update(note, fields) {
    const n = await db.update('notes', note.id, typeof fields === 'string' ? { content: fields } : fields);
    setNotes((l) => l.map((x) => (x.id === n.id ? n : x)));
  }
  async function remove(note) {
    await db.remove('notes', note.id);
    setNotes((l) => l.filter((x) => x.id !== note.id));
  }

  return html`<section class="notes">
    <h3>Notizen ${notes && html`<span class="count">${notes.length}</span>`}</h3>
    <form class="note-new" onSubmit=${add}>
      <textarea ref=${textRef} rows="3" placeholder=${filter.card_id && others.length ? 'Notiz schreiben … mit @Name erwähnst du jemanden' : 'Notiz schreiben …'}
        value=${text} onInput=${(e) => setText(e.target.value)}
        onKeyDown=${(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) add(e); }}></textarea>
      ${filter.card_id && others.length > 0 && html`<div class="mention-row">
        <span class="muted small">Erwähnen:</span>
        ${others.map((u) => html`<button type="button" key=${u.email} class="chip" onClick=${() => insertMention(u)}>@${u.name.split(/\s+/)[0]}</button>`)}
      </div>`}
      <div class="note-new-actions">
        ${!isGuest && filter.card_id && html`<label class="check-line small" title="Nur du siehst diese Notiz, alle anderen mit Zugriff auf den Deal nicht">
          <input type="checkbox" checked=${priv} onChange=${(e) => setPriv(e.target.checked)} /><${Icon} n="lock" />Nur für mich</label>`}
        ${!isMobile && html`<span class="hint">Strg + Enter speichert</span>`}
        <button class="btn primary sm" disabled=${busy || !text.trim()}>Notiz speichern</button>
      </div>
    </form>
    ${notes === null
    ? html`<p class="muted small">Lädt …</p>`
    : notes.map((n) => html`<${NoteItem} key=${n.id} note=${n} showCard=${!filter.card_id} onSave=${update} onDelete=${remove} />`)}
  </section>`;
}

function NoteItem({ note, showCard, onSave, onDelete }) {
  const { idx, actions, isGuest, me, users } = useApp();
  // Bei Notizen von Claude zeigt schon die Plakette „Claude“, wer geschrieben hat
  const author = note.author && note.author.toLowerCase() !== me && note.source !== 'claude'
    ? idx.userName.get(note.author.toLowerCase()) || note.author : null;
  // Ändern und löschen darf nur, wem die Notiz gehört
  const mine = idx.ownsRow(note);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const clean = useMemo(() => highlightMentions(sanitize(note.content), users), [note.content, users]);
  const long = clean.length > 700;
  const card = showCard && note.card_id ? idx.card.get(note.card_id) : null;

  async function save() {
    try { await onSave(note, textToHtml(text)); setEditing(false); } catch (e) { actions.fail(e); }
  }
  async function del() {
    if (!confirm('Notiz löschen?')) return;
    try { await onDelete(note); } catch (e) { actions.fail(e); }
  }

  return html`<article class="note">
    <header class="note-head">
      <span>${fullDate(note.created_at)}</span>
      ${note.source === 'meeting' && html`<span class="badge">Meeting</span>`}
      ${note.source === 'claude' && html`<span class="badge">Claude</span>`}
      ${card && html`<a class="badge link" href=${`#/karte/${card.id}`} title=${card.title}>${card.title}</a>`}
      ${author && html`<span class="badge author">${author}</span>`}
      ${note.private && html`<span class="badge private" title="Nur du siehst diese Notiz"><${Icon} n="lock" />Nur für mich</span>`}
      <span class="spacer"></span>
      ${!isGuest && mine && note.card_id && !editing && html`<button class="btn ghost xs" title=${note.private ? 'Für alle sichtbar machen, die den Deal sehen' : 'Nur für mich'}
        onClick=${async () => { try { await onSave(note, { private: !note.private }); } catch (e) { actions.fail(e); } }}>
        ${note.private ? 'Freigeben' : html`<${Icon} n="lock" />`}</button>`}
      ${!editing && note.source !== 'meeting' && mine && html`<button class="btn ghost xs"
        onClick=${() => { setText(htmlToText(note.content)); setEditing(true); }}>Bearbeiten</button>`}
      ${!isGuest && mine && html`<button class="btn ghost xs danger" onClick=${del}>Löschen</button>`}
    </header>
    ${editing ? html`<div class="note-edit">
        <textarea rows="5" value=${text} onInput=${(e) => setText(e.target.value)}></textarea>
        <div class="row-actions">
          <button class="btn primary sm" onClick=${save} disabled=${!text.trim()}>Speichern</button>
          <button class="btn ghost sm" onClick=${() => setEditing(false)}>Abbrechen</button>
        </div>
      </div>` : html`
      <div class=${'note-body' + (long && !open ? ' clamped' : '')} dangerouslySetInnerHTML=${{ __html: clean }}></div>
      ${long && html`<button class="btn link sm" onClick=${() => setOpen(!open)}>${open ? 'Weniger anzeigen' : 'Ganze Notiz anzeigen'}</button>`}`}
  </article>`;
}

// ---------------------------------------------------------------------------
// Termine (kommen über tools/kalender_abgleich.py aus allen Kalendern)
// ---------------------------------------------------------------------------
const localDay = (d) => {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
};
const eventDay = (e) => (e.all_day ? e.start_at.slice(0, 10) : localDay(e.start_at));
const addDays = (day, n) => localDay(Date.parse(day + 'T12:00:00') + n * 864e5);
function dayLabel(day) {
  const diff = Math.round((Date.parse(day) - Date.parse(todayStr())) / 864e5);
  if (diff === 0) return 'Heute';
  if (diff === 1) return 'Morgen';
  if (diff === -1) return 'Gestern';
  return new Date(day + 'T00:00').toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' });
}
const hm = (iso) => new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
const timeRange = (e) => (e.all_day ? 'ganztägig' : e.end_at ? `${hm(e.start_at)}–${hm(e.end_at)}` : hm(e.start_at));
const isPast = (e) => ts(e.end_at || e.start_at) < Date.now();

function EventRow({ ev }) {
  const { idx } = useApp();
  const guests = [...(idx.guestsOf.get(ev.id) || [])].map((id) => idx.person.get(id)?.name).filter(Boolean);
  const cals = idx.calendarsOf.get(ev.id) || [ev.calendar_name];
  const who = guests.slice(0, 3).join(', ') + (guests.length > 3 ? ` +${guests.length - 3}` : '');
  const open = () => go('#/termin/' + ev.id);
  return html`<div class=${'ev' + (isPast(ev) ? ' past' : '')} role="link" tabindex="0"
      style=${`--cc:${ev.calendar_color || '#a9b4ae'}`} onClick=${open} onKeyDown=${(e) => { if (e.key === 'Enter') open(); }}>
    <div class="ev-time">${timeRange(ev)}</div>
    <div class="ev-main">
      <div class="ev-title">${ev.title}</div>
      <div class="ev-meta"><span class="dot"></span>${cals.join(', ')}${who ? ' · ' + who : ''}</div>
    </div>
    ${ev.meet_url && !isPast(ev) && html`<a class="btn xs ev-join" href=${ev.meet_url} target="_blank" rel="noopener"
      onClick=${(e) => e.stopPropagation()}><${Icon} n="video" />Beitreten</a>`}
  </div>`;
}

function EventDays({ list }) {
  const days = new Map();
  list.forEach((e) => {
    const d = eventDay(e);
    if (!days.has(d)) days.set(d, []);
    days.get(d).push(e);
  });
  return html`${[...days.entries()].map(([d, evs]) => html`<div class="ev-day" key=${d}>
    <h3 class=${d === todayStr() ? 'today' : ''}>${dayLabel(d)}</h3>
    ${evs.sort((a, b) => (b.all_day - a.all_day) || ts(a.start_at) - ts(b.start_at)).map((e) => html`<${EventRow} key=${e.id} ev=${e} />`)}
  </div>`)}`;
}

// Wochenansicht wie in Google Kalender: Zeitraster, Termine als Blöcke, Linie für jetzt
const WK_HOUR = 48; // Pixel pro Stunde
const WK_DOW = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
const MONTHS_SHORT = ['Jan.', 'Feb.', 'März', 'Apr.', 'Mai', 'Juni', 'Juli', 'Aug.', 'Sept.', 'Okt.', 'Nov.', 'Dez.'];
const dateOf = (day) => new Date(day + 'T12:00:00');
const mondayOf = (day) => addDays(day, -((dateOf(day).getDay() + 6) % 7));
function isoWeek(day) {
  const d = dateOf(day);
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7)); // Donnerstag dieser Woche
  const jan4 = new Date(d.getFullYear(), 0, 4, 12);
  return 1 + Math.round(((d - jan4) / 864e5 - 3 + ((jan4.getDay() + 6) % 7)) / 7);
}
function rangeTitle(first, last) {
  const a = dateOf(first);
  const b = dateOf(last);
  const month = (d) => d.toLocaleDateString('de-DE', { month: 'long' });
  if (a.getMonth() === b.getMonth()) return `${month(a)} ${a.getFullYear()}`;
  const short = (d) => MONTHS_SHORT[d.getMonth()];
  return a.getFullYear() === b.getFullYear() ? `${short(a)} – ${short(b)} ${b.getFullYear()}`
    : `${short(a)} ${a.getFullYear()} – ${short(b)} ${b.getFullYear()}`;
}
// Dunkle oder helle Schrift je nach Kalenderfarbe
function inkFor(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return '#1b2521';
  const n = parseInt(m[1], 16);
  return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255 > 0.55 ? '#1b2521' : '#ffffff';
}
// Termine eines Tages anordnen: was sich überschneidet, steht nebeneinander
function layoutDay(evs, day) {
  const start = Date.parse(day + 'T00:00:00');
  const end = Date.parse(addDays(day, 1) + 'T00:00:00');
  const items = evs.map((e) => {
    const s = Math.max(ts(e.start_at), start);
    const en = Math.min(ts(e.end_at) || s + 30 * 6e4, end);
    return { e, s, en: Math.max(en, s + 20 * 6e4) }; // sehr kurze Termine mindestens 20 Minuten hoch
  }).sort((a, b) => a.s - b.s || b.en - a.en);
  const out = [];
  let cluster = [];
  let cols = [];
  let clusterEnd = 0;
  const flush = () => { cluster.forEach((it) => { it.n = cols.length; }); out.push(...cluster); cluster = []; cols = []; };
  items.forEach((it) => {
    if (cluster.length && it.s >= clusterEnd) flush();
    let c = cols.findIndex((free) => free <= it.s);
    if (c < 0) { c = cols.length; cols.push(it.en); } else cols[c] = it.en;
    it.col = c;
    cluster.push(it);
    clusterEnd = cluster.length === 1 ? it.en : Math.max(clusterEnd, it.en);
  });
  flush();
  return out.map((it) => ({ ...it, top: ((it.s - start) / 36e5) * WK_HOUR, height: ((it.en - it.s) / 36e5) * WK_HOUR }));
}
// Ganztägige Termine: Google liefert das Ende als Folgetag (exklusiv)
const allDayCovers = (e, day) => {
  const from = e.start_at.slice(0, 10);
  const to = e.end_at ? e.end_at.slice(0, 10) : addDays(from, 1);
  return day >= from && day < to;
};

function WeekView({ list, start, span }) {
  const days = Array.from({ length: span }, (_, i) => addDays(start, i));
  const scroller = useRef(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60e3);
    return () => clearInterval(t);
  }, []);
  // Beim Öffnen auf 7 Uhr scrollen
  useEffect(() => { if (scroller.current) scroller.current.scrollTop = 7 * WK_HOUR; }, []);
  const today = todayStr();
  const timed = list.filter((e) => !e.all_day);
  const allDay = list.filter((e) => e.all_day);
  const open = (e) => go('#/termin/' + e.id);
  const nowMin = (now - Date.parse(today + 'T00:00:00')) / 6e4;
  // Klick in eine freie Stelle: neuer Termin zur angeklickten halben Stunde
  const newAt = (ev, d) => {
    if (ev.target !== ev.currentTarget) return;
    const min = Math.floor(((ev.clientY - ev.currentTarget.getBoundingClientRect().top) / WK_HOUR) * 2) * 30;
    go(`#/termin/neu?tag=${d}&zeit=${pad2(Math.floor(min / 60))}:${pad2(min % 60)}`);
  };

  return html`<div class="wk" style=${`--days:${span};--hour:${WK_HOUR}px`}>
    <div class="wk-scroll" ref=${scroller}>
      <div class="wk-sticky">
        <div class="wk-row wk-head">
          <div class="wk-gutter"></div>
          ${days.map((d) => html`<div key=${d} class=${'wk-dayhead' + (d === today ? ' today' : '') + (d < today ? ' past' : '')}>
            <span class="wk-dow">${WK_DOW[dateOf(d).getDay()]}</span><span class="wk-date">${dateOf(d).getDate()}</span>
          </div>`)}
        </div>
        ${allDay.length > 0 && html`<div class="wk-row wk-allday">
          <div class="wk-gutter wk-adlabel">ganztägig</div>
          ${days.map((d) => html`<div key=${d} class="wk-adcell">
            ${allDay.filter((e) => allDayCovers(e, d)).map((e) => html`<button key=${e.id} class="wk-ad"
              style=${`--cc:${e.calendar_color || '#a9b4ae'};color:${inkFor(e.calendar_color)}`} title=${e.title}
              onClick=${() => open(e)}>${e.title}</button>`)}
          </div>`)}
        </div>`}
      </div>
      <div class="wk-row wk-body">
        <div class="wk-gutter wk-times">
          ${Array.from({ length: 23 }, (_, i) => html`<span key=${i} style=${`top:${(i + 1) * WK_HOUR}px`}>${String(i + 1).padStart(2, '0')}:00</span>`)}
        </div>
        ${days.map((d) => html`<div key=${d} class=${'wk-col' + (d === today ? ' today' : '')} onClick=${(ev) => newAt(ev, d)}>
          ${layoutDay(timed.filter((e) => ts(e.start_at) < Date.parse(addDays(d, 1) + 'T00:00:00')
            && (ts(e.end_at) || ts(e.start_at) + 1) > Date.parse(d + 'T00:00:00')), d).map((it) => html`<div key=${it.e.id}
              class=${'wk-ev' + (isPast(it.e) ? ' past' : '') + (it.height < 34 ? ' short' : '')} role="link" tabindex="0"
              title=${`${timeRange(it.e)} ${it.e.title}`}
              style=${`top:${it.top}px;height:${it.height - 2}px;left:calc(${it.col} * 100% / ${it.n});width:calc(100% / ${it.n} - 3px);--cc:${it.e.calendar_color || '#a9b4ae'};color:${inkFor(it.e.calendar_color)}`}
              onClick=${() => open(it.e)} onKeyDown=${(ev) => { if (ev.key === 'Enter') open(it.e); }}>
            <span class="wk-ev-title">${it.e.title}</span>
            <span class="wk-ev-time">${it.height < 34 ? ', ' : ''}${timeRange(it.e)}</span>
          </div>`)}
          ${d === today && html`<div class="wk-now" style=${`top:${(nowMin / 60) * WK_HOUR}px`}></div>`}
        </div>`)}
      </div>
    </div>
  </div>`;
}

// Kleiner Monatskalender links (wie in Google Kalender), Klick springt zur Woche
function MiniMonth({ first, span, onPick }) {
  const [month, setMonth] = useState(() => first.slice(0, 7));
  useEffect(() => { setMonth(first.slice(0, 7)); }, [first]);
  const start = mondayOf(month + '-01');
  const weeks = Array.from({ length: 6 }, (_, w) => Array.from({ length: 7 }, (_, i) => addDays(start, w * 7 + i)));
  const shift = (n) => {
    const d = dateOf(month + '-01');
    d.setMonth(d.getMonth() + n);
    setMonth(localDay(d).slice(0, 7));
  };
  const today = todayStr();
  const last = addDays(first, span - 1);
  return html`<div class="mini-month">
    <div class="mm-head">
      <strong>${dateOf(month + '-01').toLocaleDateString('de-DE', { month: 'long', year: 'numeric' })}</strong>
      <span class="spacer"></span>
      <button class="icon-btn sm" aria-label="Voriger Monat" onClick=${() => shift(-1)}><${Icon} n="back" /></button>
      <button class="icon-btn sm" aria-label="Nächster Monat" onClick=${() => shift(1)}><${Icon} n="next" /></button>
    </div>
    <div class="mm-grid">
      <span class="mm-kw"></span>${['M', 'D', 'M', 'D', 'F', 'S', 'S'].map((x, i) => html`<span key=${i} class="mm-dow">${x}</span>`)}
      ${weeks.map((w) => html`<span key=${'k' + w[0]} class="mm-kw">${isoWeek(w[0])}</span>
        ${w.map((d) => html`<button key=${d} onClick=${() => onPick(d)}
          class=${['mm-day', d.slice(0, 7) !== month && 'other', d === today && 'today', d >= first && d <= last && 'sel'].filter(Boolean).join(' ')}>
          ${dateOf(d).getDate()}</button>`)}`)}
    </div>
  </div>`;
}

function CalendarPage() {
  const { idx, isMobile } = useApp();
  const [hidden, setHidden] = useState(() => {
    try { return new Set(JSON.parse(ls.get('crm-cal-hidden') || '[]')); } catch { return new Set(); }
  });
  const [view, setView] = useState(() => ls.get('crm-cal-view') || 'woche');
  const [anchor, setAnchor] = useState(null); // null = aktuelle Woche bzw. ab heute
  const [withPast, setWithPast] = useState(false);
  const calendars = useMemo(() => {
    const m = new Map();
    idx.events.forEach((e) => (idx.calendarsOf.get(e.id) || [e.calendar_name]).forEach((c) => {
      if (!m.has(c)) m.set(c, e.calendar_name === c ? e.calendar_color : m.get(c));
    }));
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0], 'de'));
  }, [idx]);
  function toggle(name) {
    const s = new Set(hidden);
    if (s.has(name)) s.delete(name); else s.add(name);
    setHidden(s);
    ls.set('crm-cal-hidden', JSON.stringify([...s]));
  }
  const pickView = (v) => { setView(v); ls.set('crm-cal-view', v); };
  const shown = (e) => !(idx.calendarsOf.get(e.id) || [e.calendar_name]).every((c) => hidden.has(c));

  // Am Rechner die Woche ab Montag, am Handy drei Tage ab heute
  const span = isMobile ? 3 : 7;
  const first = anchor || (isMobile ? todayStr() : mondayOf(todayStr()));
  const last = addDays(first, span - 1);
  const pick = (day) => { setAnchor(isMobile ? day : mondayOf(day)); pickView('woche'); };
  const weekList = idx.events.filter((e) => shown(e) && eventDay(e) <= last
    && (e.all_day ? (e.end_at ? addDays(e.end_at.slice(0, 10), -1) : eventDay(e)) : localDay(e.end_at || e.start_at)) >= first);
  const from = withPast ? addDays(todayStr(), -30) : todayStr();
  const list = idx.events.filter((e) => shown(e) && eventDay(e) >= from);

  const calendarToggles = html`${calendars.map(([name, color]) => html`<button key=${name}
    class=${'chip toggle cal' + (hidden.has(name) ? '' : ' on')} style=${`--cc:${color || '#a9b4ae'}`}
    onClick=${() => toggle(name)}><span class="dot"></span>${name}</button>`)}`;

  if (idx.events.length === 0) {
    return html`<div class="page"><${PageHead} title="Kalender" />
      <div class="empty-state"><h2>Noch keine Termine</h2><p class="muted">Sobald der Kalender-Abgleich eingerichtet ist, stehen hier alle Termine aus deinen Kalendern.</p></div></div>`;
  }
  return html`<div class="page cal-page">
    <div class="cal-toolbar">
      ${view === 'woche' ? html`
        <button class="btn sm" onClick=${() => setAnchor(null)}>Heute</button>
        <button class="icon-btn" aria-label="Zurück" onClick=${() => setAnchor(addDays(first, -span))}><${Icon} n="back" /></button>
        <button class="icon-btn" aria-label="Weiter" onClick=${() => setAnchor(addDays(first, span))}><${Icon} n="next" /></button>
        <h1 class="cal-title">${rangeTitle(first, last)}</h1>
        ${!isMobile && html`<span class="badge">KW ${isoWeek(first)}</span>`}`
    : html`<h1 class="cal-title">Termine</h1><span class="count">${list.length}</span>
        <button class="btn ghost sm" onClick=${() => setWithPast(!withPast)}>${withPast ? 'Ab heute' : 'Letzte 30 Tage'}</button>`}
      <span class="spacer"></span>
      <a class="btn primary sm" href="#/termin/neu"><${Icon} n="plus" />Termin</a>
      <div class="seg small">
        <button class=${'seg-btn' + (view === 'woche' ? ' on' : '')} onClick=${() => pickView('woche')}>${isMobile ? '3 Tage' : 'Woche'}</button>
        <button class=${'seg-btn' + (view === 'liste' ? ' on' : '')} onClick=${() => pickView('liste')}>Liste</button>
      </div>
    </div>
    <div class="cal-layout">
      <aside class="cal-side">
        <${MiniMonth} first=${first} span=${view === 'woche' ? span : 0} onPick=${pick} />
        <h3 class="cal-side-title">Kalender</h3>
        <div class="cal-side-list">${calendarToggles}</div>
      </aside>
      <div class="cal-main">
        ${calendars.length > 0 && html`<div class="label-filter cal-chips">${calendarToggles}</div>`}
        ${view === 'woche' ? html`<${WeekView} list=${weekList} start=${first} span=${span} />`
    : html`<div class="tile ev-list"><${EventDays} list=${list} />${list.length === 0 && html`<p class="muted small">Keine Termine im gewählten Zeitraum.</p>`}</div>`}
      </div>
    </div>
  </div>`;
}

// Neuer Termin mit Einladungen: Das CRM darf die Kalender nur lesen. Es füllt deshalb
// Google Kalender im gewählten Konto vor, Speichern dort verschickt die Einladungen.
const pad2 = (n) => String(n).padStart(2, '0');
function nextHalfHour() {
  const d = new Date(Date.now() + 30 * 6e4);
  d.setMinutes(d.getMinutes() < 30 ? 30 : 60, 0, 0);
  return d;
}
function gcalTemplateUrl({ title, start, end, guests, details, location, meet, account }) {
  const f = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const p = new URLSearchParams({ action: 'TEMPLATE', text: title, dates: `${f(start)}/${f(end)}` });
  if (guests.length) p.set('add', guests.join(','));
  if (details) p.set('details', details);
  if (location) p.set('location', location);
  if (meet) p.set('vcon', 'meet');
  if (account) p.set('authuser', account);
  return 'https://calendar.google.com/calendar/render?' + p;
}

function NewEventSheet({ query }) {
  const { idx, persons, events } = useApp();
  const close = () => back('#/kalender');
  // Konten: die eigenen Kalender, die das CRM kennt (Kalender-ID = Mailadresse des Kontos)
  const accounts = useMemo(() => {
    const m = new Map();
    events.forEach((e) => {
      if (e.calendar_id.includes('@') && !e.calendar_id.endsWith('calendar.google.com')) m.set(e.calendar_id, e.calendar_name);
    });
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1], 'de'));
  }, [events]);
  const startDefault = (() => {
    const d = nextHalfHour();
    const day = query.get('tag') || localDay(d);
    const time = query.get('zeit') || `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    return { day, time };
  })();
  const [title, setTitle] = useState('');
  const [day, setDay] = useState(startDefault.day);
  const [from, setFrom] = useState(startDefault.time);
  const [minutes, setMinutes] = useState(30);
  const [guests, setGuests] = useState(() => {
    const p = query.get('gast') && idx.person.get(Number(query.get('gast')));
    return p && p.emails[0] ? [{ email: p.emails[0], name: p.name }] : [];
  });
  const [extra, setExtra] = useState('');
  const [location, setLocation] = useState('');
  const [details, setDetails] = useState('');
  const [meet, setMeet] = useState(true);
  const [account, setAccount] = useState(() => {
    const saved = ls.get('crm-invite-account');
    return accounts.some(([id]) => id === saved) ? saved : accounts[0]?.[0] || '';
  });

  const start = new Date(`${day}T${from || '09:00'}`);
  const end = new Date(start.getTime() + minutes * 6e4);
  const until = `${pad2(end.getHours())}:${pad2(end.getMinutes())}`;
  const setUntil = (t) => {
    const e = new Date(`${day}T${t}`);
    if (e > start) setMinutes(Math.round((e - start) / 6e4));
  };
  const withMail = useMemo(() => persons.filter((p) => (p.emails || []).length), [persons]);
  const addGuest = (email, name = '') => {
    const m = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(m) || guests.some((g) => g.email === m)) return;
    setGuests([...guests, { email: m, name }]);
  };
  const addExtra = () => { extra.split(/[\s,;]+/).forEach((m) => addGuest(m)); setExtra(''); };
  const valid = title.trim() && !Number.isNaN(start.getTime()) && minutes > 0;

  function submit(e) {
    e.preventDefault();
    if (!valid) return;
    ls.set('crm-invite-account', account);
    window.open(gcalTemplateUrl({
      title: title.trim(), start, end, guests: guests.map((g) => g.email),
      details: details.trim(), location: location.trim(), meet, account,
    }), '_blank', 'noopener');
    close();
  }

  return html`<${Sheet} title="Neuer Termin" onClose=${close}>
    <form class="form" onSubmit=${submit}>
      <label class="field"><span>Titel</span>
        <input value=${title} onInput=${(e) => setTitle(e.target.value)} placeholder="z. B. Erstgespräch Musterfirma" required /></label>
      <div class="field-row">
        <label class="field grow"><span>Datum</span><input type="date" value=${day} onInput=${(e) => setDay(e.target.value)} required /></label>
        <label class="field"><span>Von</span><input type="time" step="900" value=${from} onInput=${(e) => setFrom(e.target.value)} required /></label>
        <label class="field"><span>Bis</span><input type="time" step="900" value=${until} onInput=${(e) => setUntil(e.target.value)} /></label>
      </div>
      <div class="field"><span>Gäste</span>
        ${guests.length > 0 && html`<div class="participants">${guests.map((g) => html`<span class="chip person" key=${g.email}>
          ${g.name || g.email}<button type="button" class="chip-x" aria-label=${`${g.email} entfernen`}
            onClick=${() => setGuests(guests.filter((x) => x.email !== g.email))}>×</button></span>`)}</div>`}
        <${Combobox} items=${withMail} value=${null} label=${(p) => p.name} sub=${(p) => p.emails[0]}
          placeholder="Kontakt suchen" onChange=${(id) => { const p = idx.person.get(id); if (p) addGuest(p.emails[0], p.name); }} />
        <input type="email" value=${extra} placeholder="oder Mailadresse eintippen und Enter" onInput=${(e) => setExtra(e.target.value)}
          onKeyDown=${(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addExtra(); } }} onBlur=${addExtra} />
      </div>
      <label class="field"><span>Ort (optional)</span><input value=${location} onInput=${(e) => setLocation(e.target.value)} /></label>
      <label class="field"><span>Beschreibung (optional)</span>
        <textarea rows="3" value=${details} onInput=${(e) => setDetails(e.target.value)}></textarea></label>
      <label class="check-line"><input type="checkbox" checked=${meet} onChange=${(e) => setMeet(e.target.checked)} /> Google Meet hinzufügen</label>
      <label class="field"><span>Einladen aus Kalender</span>
        <select value=${account} onChange=${(e) => setAccount(e.target.value)}>
          ${accounts.map(([id, name]) => html`<option key=${id} value=${id}>${name} (${id})</option>`)}
          <option value="">Konto, das im Browser angemeldet ist</option>
        </select></label>
      <button class="btn primary full" disabled=${!valid}><${Icon} n="calendar" />In Google Kalender öffnen</button>
      <p class="muted small">Google Kalender öffnet sich mit allem ausgefüllt. Dort auf „Speichern“ klicken, dann verschickt Google die Einladungen. Fehlt der Meet-Link, dort „Google Meet-Videokonferenz hinzufügen“ wählen. Im CRM erscheint der Termin nach dem nächsten Abgleich, spätestens nach 15 Minuten.</p>
    </form>
  <//>`;
}

function TodayEvents() {
  const { idx } = useApp();
  const today = todayStr();
  const tomorrow = addDays(today, 1);
  const list = idx.events.filter((e) => eventDay(e) === today || eventDay(e) === tomorrow);
  return html`<section class="tile">
    <h2>Termine heute und morgen <span class="count">${list.length}</span></h2>
    ${list.length > 0 ? html`<${EventDays} list=${list} />` : html`<p class="muted small">${idx.events.length ? 'Heute und morgen keine Termine.' : 'Noch keine Kalender verbunden.'}</p>`}
    <a class="btn link sm" href="#/kalender">Zum Kalender</a>
  </section>`;
}

function EventSheet({ event: ev }) {
  const { idx, persons, meetings, actions } = useApp();
  const [full, setFull] = useState(null);
  useEffect(() => {
    if (ev) db.get('events', ev.id).then(setFull).catch(() => setFull({}));
  }, [ev?.id]);
  const close = () => back('#/kalender');
  if (!ev) return html`<${Sheet} title="Termin" onClose=${close}><p class="muted">Diesen Termin gibt es nicht mehr.</p><//>`;

  const byMail = new Map();
  persons.forEach((p) => (p.emails || []).forEach((m) => byMail.set(m.toLowerCase(), p)));
  const linked = new Set(idx.guestsOf.get(ev.id) || []);
  const meeting = meetings.find((m) => Math.abs(ts(m.held_at) - ts(ev.start_at)) <= 20 * 60e3);
  const cals = idx.calendarsOf.get(ev.id) || [ev.calendar_name];
  const desc = full?.description ? sanitize(/<[a-z]/i.test(full.description) ? full.description : escapeHtml(full.description).replace(/\n/g, '<br>')) : '';

  async function addContact(addr) {
    const name = addr.split('@')[0].split(/[._-]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
    try {
      const p = await actions.save('persons', { name, emails: [addr], labels: ['Aus Kalender'] });
      await actions.save('event_persons', { event_id: ev.id, person_id: p.id });
    } catch { /* fail */ }
  }

  return html`<${Sheet} title="Termin" onClose=${close}>
    <div class="form">
      <h2 class="ev-sheet-title">${ev.title}</h2>
      <p class="meta">${dayLabel(eventDay(ev))} · ${timeRange(ev)} · ${cals.join(', ')}</p>
      ${ev.location && html`<p class="small">Ort: ${ev.location}</p>`}
      <div class="contact-actions">
        ${ev.meet_url && html`<a class="btn primary" href=${ev.meet_url} target="_blank" rel="noopener"><${Icon} n="video" />Beitreten</a>`}
        ${ev.html_link && html`<a class="btn" href=${ev.html_link} target="_blank" rel="noopener"><${Icon} n="calendar" />Im Google Kalender</a>`}
        ${meeting && html`<a class="btn" href=${`#/meeting/${meeting.id}`}><${Icon} n="mic" />Meeting-Zusammenfassung</a>`}
      </div>
      ${(ev.attendees || []).length > 0 && html`<div class="field"><span>Teilnehmer</span>
        <div class="participants">
          ${ev.attendees.map((addr) => {
    const p = byMail.get(addr) || [...linked].map((id) => idx.person.get(id)).find((x) => x && (x.emails || []).includes(addr));
    return p
      ? html`<span class="chip person" key=${addr}><a href=${`#/kontakt/${p.id}`}>${p.name}</a></span>`
      : html`<span class="chip dashed" key=${addr}>${addr}<button type="button" class="chip-add" onClick=${() => addContact(addr)}>+ Kontakt</button></span>`;
  })}
        </div></div>`}
    </div>
    ${full === null ? html`<p class="muted small">Lädt …</p>` : desc && html`<section class="notes"><h3>Beschreibung</h3>
      <div class="note-body" dangerouslySetInnerHTML=${{ __html: desc }}></div></section>`}
  <//>`;
}

function EventsPanel({ personIds }) {
  const { idx } = useApp();
  const ids = new Set();
  personIds.forEach((pid) => (idx.eventsOf.get(pid) || []).forEach((id) => ids.add(id)));
  const list = [...ids].map((id) => idx.event.get(id)).filter(Boolean);
  if (list.length === 0) return null;
  const next = list.filter((e) => !isPast(e)).sort((a, b) => ts(a.start_at) - ts(b.start_at)).slice(0, 3);
  const last = list.filter(isPast).sort((a, b) => ts(b.start_at) - ts(a.start_at)).slice(0, 3);
  const item = (e) => html`<a key=${e.id} class="mini-card" href=${`#/termin/${e.id}`} style=${`--pc:${e.calendar_color || '#a9b4ae'}`}>
    <span class="mini-title">${e.title}</span>
    <span class="mini-meta"><span class="dot"></span>${shortDate(e.start_at)} · ${timeRange(e)}</span></a>`;
  return html`<section class="panel">
    <h3>Termine <span class="count">${list.length}</span></h3>
    ${next.length > 0 && html`<p class="panel-sub">Nächste</p>${next.map(item)}`}
    ${last.length > 0 && html`<p class="panel-sub">Letzte</p>${last.map(item)}`}
  </section>`;
}

// ---------------------------------------------------------------------------
// Meetings
// ---------------------------------------------------------------------------
function meetingNames(m, idx) {
  const linked = (idx.peopleOf.get(m.id) || []).map((l) => idx.person.get(l.person_id)?.name).filter(Boolean);
  return [...linked, ...(m.extra_names || [])];
}

function MeetingsList({ projectId }) {
  const { meetings, projects, idx } = useApp();
  const [q, setQ] = useStored('crm-q-meetings', '');
  const [limit, setLimit] = useState(80);
  const project = projectId ? idx.project.get(Number(projectId)) : null;
  const counts = useMemo(() => {
    const c = new Map();
    meetings.forEach((m) => c.set(m.project_id, (c.get(m.project_id) || 0) + 1));
    return c;
  }, [meetings]);
  // Ab drei Zeichen wird auch in den Zusammenfassungen gesucht (in der Datenbank).
  const [hits, setHits] = useState(null);
  useEffect(() => {
    const t = q.trim();
    if (t.length < 3) { setHits(null); return undefined; }
    let alive = true;
    const timer = setTimeout(() => {
      db.searchText('meetings', 'summary', t)
        .then((rows) => { if (alive) setHits(new Set(rows.map((r) => r.id))); })
        .catch(() => { if (alive) setHits(null); });
    }, 350);
    return () => { alive = false; clearTimeout(timer); };
  }, [q]);
  const list = useMemo(() => meetings
    .filter((m) => (!project || m.project_id === project.id)
      && (matches(q, m.title, meetingNames(m, idx)) || hits?.has(m.id)))
    .sort(byHeldDesc), [meetings, project, q, idx, hits]);

  const rows = [];
  let month = '';
  list.slice(0, limit).forEach((m) => {
    const label = monthLabel(m.held_at);
    if (label !== month) {
      rows.push(html`<div class="month-head" key=${'h' + label}>${label}</div>`);
      month = label;
    }
    rows.push(html`<${MeetingRow} key=${m.id} meeting=${m} showProject=${!project} />`);
  });

  return html`<div class="page">
    <${PageHead} title="Meetings" count=${list.length} />
    <div class="project-tabs filter">
      <a href="#/meetings" class=${'ptab all' + (!project ? ' on' : '')}>Alle<span class="ptab-n">${meetings.length}</span></a>
      ${projects.map((p) => html`<a key=${p.id} href=${`#/meetings/${p.id}`} class=${'ptab' + (project?.id === p.id ? ' on' : '')}
        style=${`--pc:${p.color}`}><span class="dot"></span>${p.name}<span class="ptab-n">${counts.get(p.id) || 0}</span></a>`)}
    </div>
    <div class="toolbar"><${SearchBox} value=${q} onInput=${setQ} placeholder="Titel, Teilnehmer oder Inhalt" /></div>
    <div class="list">
      ${rows}
      ${list.length > limit && html`<button class="btn ghost full" onClick=${() => setLimit(limit + 100)}>Weitere anzeigen</button>`}
      ${list.length === 0 && html`<p class="muted pad">Keine Meetings gefunden.</p>`}
    </div>
  </div>`;
}

function MeetingRow({ meeting: m, showProject }) {
  const { idx } = useApp();
  const d = new Date(m.held_at);
  const pr = idx.project.get(m.project_id);
  const names = meetingNames(m, idx);
  const who = names.slice(0, 4).join(', ') + (names.length > 4 ? ` +${names.length - 4}` : '');
  const sub = [m.duration_min ? `${m.duration_min} Min.` : '', who].filter(Boolean).join(' · ');
  return html`<a class="row meeting-row" href=${`#/meeting/${m.id}`}>
    <div class="mdate"><b>${d.getDate()}</b><span>${d.toLocaleDateString('de-DE', { month: 'short' }).replace('.', '')}</span></div>
    <div class="row-main"><div class="row-title">${m.title}</div>${sub && html`<div class="row-sub">${sub}</div>`}</div>
    ${showProject && pr && html`<span class="pchip" style=${`--pc:${pr.color}`}><span class="dot"></span>${pr.name}</span>`}
  </a>`;
}

// Action Items aus der Zusammenfassung: Überschrift „Action Items“, darunter
// je Person eine h3 und eine Liste. Zeitmarken wie „(31:30)“ fallen weg.
// Eigene Action Items erkennt die App am Namen: ein Wort der Überschrift muss
// in der Login-Adresse stecken, etwa „Muster“ in „a.muster@…“.
function ownerMatcher(email) {
  const parts = (email || '').split('@')[0].toLowerCase().split(/[._-]+/).filter((p) => p.length >= 3);
  return (owner) => owner.toLowerCase().split(/\s+/).some((w) => parts.includes(w));
}
function parseActionItems(summary, isMe) {
  const doc = new DOMParser().parseFromString(sanitize(summary), 'text/html');
  const head = [...doc.querySelectorAll('h2')].find((h) => /action items/i.test(h.textContent));
  const items = [];
  let owner = '';
  for (let el = head?.nextElementSibling; el && el.tagName !== 'H2'; el = el.nextElementSibling) {
    if (el.tagName === 'H3') {
      owner = el.textContent.trim();
      continue;
    }
    const lis = el.tagName === 'LI' ? [el] : [...el.querySelectorAll('li')];
    lis.forEach((li) => {
      if (li.parentElement.closest('li')) return;
      const text = (li.querySelector('p') || li).textContent
        .replace(/\s*\(\d{1,2}:\d{2}(?::\d{2})?\)\s*$/, '').replace(/\s+/g, ' ').trim();
      if (text) items.push({ owner, text, mine: isMe(owner) });
    });
  }
  return items;
}

function MeetingSheet({ meeting: m }) {
  const { idx, projects, persons, cards, stages, actions, session } = useApp();
  const [full, setFull] = useState(null);
  const [items, setItems] = useState([]);
  const [title, setTitle] = useState(m?.title || '');
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!m) return;
    db.get('meetings', m.id).then((row) => {
      setFull(row);
      setItems(parseActionItems(row.summary, ownerMatcher(session?.user?.email)));
    }).catch(actions.fail);
  }, [m?.id]);
  const close = () => back(m?.project_id ? `#/meetings/${m.project_id}` : '#/meetings');

  if (!m) return html`<${Sheet} title="Meeting" onClose=${close}><p class="muted">Dieses Meeting gibt es nicht mehr.</p><//>`;

  const links = idx.peopleOf.get(m.id) || [];
  const linkedIds = new Set(links.map((l) => l.person_id));
  const linked = links.map((l) => ({ l, p: idx.person.get(l.person_id) })).filter((x) => x.p);
  const extra = m.extra_names || [];
  const summary = full ? sanitize(full.summary) : null;
  const long = summary && summary.length > 1500;
  const firefliesUrl = m.fireflies_id && !m.fireflies_id.startsWith('pipedrive-')
    ? `https://app.fireflies.ai/view/${m.fireflies_id}` : null;

  async function saveTitle() {
    const t = title.trim();
    if (t && t !== m.title) await actions.patch('meetings', m.id, { title: t });
    else setTitle(m.title);
  }
  async function addPerson(personId) {
    if (!personId || linkedIds.has(personId)) return;
    try { await actions.save('meeting_persons', { meeting_id: m.id, person_id: personId }); } catch { /* fail */ }
  }
  const removeName = (name) => actions.patch('meetings', m.id, { extra_names: extra.filter((n) => n !== name) });
  // Teilnehmer ohne Kontakt: als Kontakt anlegen (oder vorhandenen gleichen Namens nehmen) und verknüpfen
  async function nameToContact(name) {
    try {
      const p = persons.find((x) => norm(x.name) === norm(name)) || await actions.save('persons', { name });
      await addPerson(p.id);
      await removeName(name);
    } catch { /* fail */ }
  }
  async function del() {
    if (!confirm('Meeting löschen?')) return;
    try { await actions.remove('meetings', m.id); close(); } catch { /* fail */ }
  }

  // Action Items aufs Board: eigene nach „To-Dos“, die der anderen nach
  // „Feedback von Anderen“ (darauf wartest du).
  const onBoard = new Map(cards.filter((c) => c.meeting_id === m.id).map((c) => [norm(c.title), c]));
  const mine = items.filter((it) => it.mine);
  const others = items.filter((it) => !it.mine);
  function stageFor(pid, wanted) {
    const cols = stages.filter((s) => s.project_id === pid).sort(bySort);
    return cols.find((s) => stageKind(s) === wanted) || cols.find((s) => stageKind(s) === 'todo') || cols[0];
  }
  async function toBoard(it) {
    const pid = m.project_id || projects.find((p) => norm(p.name) === 'allgemein')?.id || projects[0]?.id;
    const ownerFirst = norm(it.owner).split(' ')[0];
    const person = it.mine
      ? (linked.length === 1 ? linked[0].p : null)
      : linked.map((x) => x.p).find((p) => ownerFirst && norm(p.name).split(' ').includes(ownerFirst)) || null;
    try {
      await actions.save('cards', {
        title: it.text, project_id: pid, stage_id: stageFor(pid, it.mine ? 'todo' : 'waiting').id,
        person_id: person?.id ?? null, org_id: person?.org_id ?? null, meeting_id: m.id,
      });
    } catch { /* fail */ }
  }
  async function allToBoard() {
    for (const it of mine.filter((x) => !onBoard.has(norm(x.text)))) await toBoard(it);
  }
  const itemRow = (it, i) => {
    const card = onBoard.get(norm(it.text));
    return html`<div class="action-item" key=${i}>
      <div class="ai-text">${!it.mine && it.owner && html`<span class="ai-owner">${it.owner}: </span>`}${it.text}</div>
      ${card
    ? html`<a class="btn ghost xs on-board" href=${`#/karte/${card.id}`}><${Icon} n="check" />Auf dem Board</a>`
    : html`<button type="button" class="btn xs" onClick=${() => toBoard(it)}>+ Board</button>`}
    </div>`;
  };
  const openMine = mine.filter((x) => !onBoard.has(norm(x.text))).length;

  return html`<${Sheet} title="Meeting" onClose=${close}>
    <div class="form">
      <label class="field"><span>Titel</span>
        <input class="title-input" value=${title} onInput=${(e) => setTitle(e.target.value)} onBlur=${saveTitle}
          onKeyDown=${(e) => { if (e.key === 'Enter') e.target.blur(); }} /></label>
      <p class="meta">${fullDate(m.held_at)} Uhr${m.duration_min ? ` · ${m.duration_min} Minuten` : ''}</p>
      <label class="field"><span>Projekt</span>
        <select value=${m.project_id ?? ''} onChange=${(e) => actions.patch('meetings', m.id, { project_id: e.target.value ? Number(e.target.value) : null })}>
          <option value="">Kein Projekt</option>
          ${projects.map((p) => html`<option key=${p.id} value=${p.id}>${p.name}</option>`)}
        </select></label>
      <div class="field"><span>Teilnehmer</span>
        <div class="participants">
          ${linked.map(({ l, p }) => html`<span class="chip person" key=${'l' + l.id}>
            <a href=${`#/kontakt/${p.id}`}>${p.name}</a>
            <button type="button" class="chip-x" aria-label=${p.name + ' entfernen'} onClick=${() => actions.drop('meeting_persons', l.id).catch(() => {})}>×</button>
          </span>`)}
          ${extra.map((n) => html`<span class="chip dashed" key=${'n' + n} title="Noch kein Kontakt im CRM">${n}
            <button type="button" class="chip-add" onClick=${() => nameToContact(n)}>+ Kontakt</button>
            <button type="button" class="chip-x" aria-label=${n + ' entfernen'} onClick=${() => removeName(n)}>×</button>
          </span>`)}
          ${linked.length === 0 && extra.length === 0 && html`<span class="muted small">Noch keine Teilnehmer zugeordnet.</span>`}
        </div>
        <${Combobox} items=${persons.filter((p) => !linkedIds.has(p.id))} value=${null} onChange=${addPerson}
          label=${(p) => p.name} sub=${(p) => idx.org.get(p.org_id)?.name} placeholder="Kontakt hinzufügen"
          onCreate=${async (name) => (await actions.save('persons', { name })).id} />
      </div>
    </div>
    ${items.length > 0 && html`<section class="notes action-items">
      <h3>Aufgaben aus dem Meeting
        ${openMine > 1 && html`<button type="button" class="btn sm ai-all" onClick=${allToBoard}>Alle ${openMine} aufs Board</button>`}</h3>
      ${mine.map(itemRow)}
      ${mine.length === 0 && html`<p class="muted small">Für dich wurden keine Aufgaben erkannt.</p>`}
      ${others.length > 0 && html`<details class="ai-others"><summary>Aufgaben der anderen (${others.length})</summary>
        <p class="muted small">Landen auf dem Board unter „Feedback von Anderen“.</p>
        ${others.map(itemRow)}</details>`}
    </section>`}
    <section class="notes">
      <h3>Zusammenfassung</h3>
      ${summary === null ? html`<p class="muted small">Lädt …</p>` : html`
        <div class=${'note-body' + (long && !open ? ' clamped tall' : '')} dangerouslySetInnerHTML=${{ __html: summary }}></div>
        ${long && html`<button class="btn link sm" onClick=${() => setOpen(!open)}>${open ? 'Weniger anzeigen' : 'Ganze Zusammenfassung anzeigen'}</button>`}`}
      ${firefliesUrl && html`<p class="meta fireflies-link"><a href=${firefliesUrl} target="_blank" rel="noopener">Aufnahme in Fireflies öffnen</a> (ältere Aufnahmen hat Fireflies teils schon gelöscht)</p>`}
    </section>
    <div class="form-actions"><span class="spacer"></span>
      <button type="button" class="btn ghost danger" onClick=${del}>Meeting löschen</button></div>
  <//>`;
}

function MeetingsPanel({ ids }) {
  const { idx } = useApp();
  const [all, setAll] = useState(false);
  const list = [...new Set(ids)].map((id) => idx.meeting.get(id)).filter(Boolean).sort(byHeldDesc);
  if (list.length === 0) return null;
  return html`<section class="panel">
    <h3>Meetings <span class="count">${list.length}</span></h3>
    ${(all ? list : list.slice(0, 5)).map((m) => {
    const pr = idx.project.get(m.project_id);
    return html`<a key=${m.id} class="mini-card" href=${`#/meeting/${m.id}`} style=${`--pc:${pr?.color || '#888'}`}>
        <span class="mini-title">${m.title}</span>
        <span class="mini-meta"><span class="dot"></span>${shortDate(m.held_at)}${pr ? ` · ${pr.name}` : ''}</span>
      </a>`;
  })}
    ${list.length > 5 && html`<button class="btn link sm" onClick=${() => setAll(!all)}>${all ? 'Weniger anzeigen' : `Alle ${list.length} anzeigen`}</button>`}
  </section>`;
}

// ---------------------------------------------------------------------------
// E-Mails (kommen über tools/mail_abgleich.py aus den Postfächern)
// ---------------------------------------------------------------------------
const EMAIL_COLUMNS = 'id,thread_id,mailbox,gmail_id,direction,from_email,from_name,to_emails,cc_emails,subject,sent_at,attachments';
// Ab hier beginnt meist der zitierte Verlauf einer Antwort
const QUOTE_START = /^(Am .{4,160}schrieb.{0,120}:|On .{4,160}wrote:|-{2,}\s*(Original Message|Ursprüngliche Nachricht)|Von: .+|From: .+|>.*)\s*$/m;

function EmailsPanel({ personIds }) {
  const { actions } = useApp();
  const [mails, setMails] = useState(null);
  const [limit, setLimit] = useState(10);
  const key = personIds.join(',');
  useEffect(() => {
    let alive = true;
    setMails(null);
    (async () => {
      const links = personIds.length ? await db.listIn('email_persons', 'person_id', personIds, 'email_id') : [];
      const ids = [...new Set(links.map((l) => l.email_id))];
      const rows = ids.length ? await db.listIn('emails', 'id', ids, EMAIL_COLUMNS) : [];
      if (alive) setMails(rows.sort((a, b) => ts(b.sent_at) - ts(a.sent_at)));
    })().catch((e) => { actions.fail(e); if (alive) setMails([]); });
    return () => { alive = false; };
  }, [key]);

  if (mails && mails.length === 0) return null;
  return html`<section class="notes mails">
    <h3>E-Mails ${mails && html`<span class="count">${mails.length}</span>`}</h3>
    ${mails === null ? html`<p class="muted small">Lädt …</p>` : mails.slice(0, limit).map((m) => html`<${EmailItem} key=${m.id} mail=${m} />`)}
    ${mails && mails.length > limit && html`<button class="btn link sm" onClick=${() => setLimit(limit + 20)}>Ältere anzeigen</button>`}
  </section>`;
}

function EmailItem({ mail: m }) {
  const { actions } = useApp();
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState(null);
  const [showQuote, setShowQuote] = useState(false);
  async function toggle() {
    setOpen(!open);
    if (!open && body === null) {
      try { setBody((await db.get('emails', m.id)).body || ''); } catch (e) { actions.fail(e); }
    }
  }
  const out = m.direction === 'out';
  const who = out ? `an ${(m.to_emails || []).join(', ')}` : (m.from_name || m.from_email);
  const cut = body ? body.search(QUOTE_START) : -1;
  const main = body && cut > 0 ? body.slice(0, cut).trimEnd() : body;
  const quote = body && cut > 0 ? body.slice(cut) : '';
  const gmailUrl = m.gmail_id ? `https://mail.google.com/mail/?authuser=${encodeURIComponent(m.mailbox)}#all/${m.gmail_id}` : null;
  return html`<article class=${'mail' + (open ? ' open' : '')}>
    <button type="button" class="mail-head" onClick=${toggle} aria-expanded=${open}>
      <span class=${'mail-dir ' + (out ? 'out' : 'in')} title=${out ? 'Gesendet' : 'Empfangen'}>${out ? '↗' : '↘'}</span>
      <span class="mail-main">
        <span class="mail-subject">${m.subject || '(ohne Betreff)'}</span>
        <span class="mail-meta">${who} · ${fullDate(m.sent_at)}</span>
      </span>
    </button>
    ${open && html`<div class="mail-body">
      ${body === null ? html`<p class="muted small">Lädt …</p>` : html`
        <div class="mail-text">${main || '(kein Text)'}</div>
        ${quote && html`<button class="btn link sm" onClick=${() => setShowQuote(!showQuote)}>${showQuote ? 'Verlauf ausblenden' : 'Zitierten Verlauf anzeigen'}</button>`}
        ${quote && showQuote && html`<div class="mail-text quote">${quote}</div>`}`}
      ${(m.attachments || []).length > 0 && html`<p class="meta">Anhänge: ${m.attachments.join(', ')}</p>`}
      <p class="meta">Postfach ${m.mailbox}${gmailUrl ? html` · <a href=${gmailUrl} target="_blank" rel="noopener">In Gmail öffnen</a>` : ''}</p>
    </div>`}
  </article>`;
}

// ---------------------------------------------------------------------------
// Kontakte
// ---------------------------------------------------------------------------
function PersonsList() {
  const { persons, idx, isMobile } = useApp();
  const [q, setQ] = useStored('crm-q-kontakte', '');
  const [label, setLabel] = useStored('crm-l-kontakte', '');
  const [sort, setSort] = useStored('crm-s-kontakte', 'neu');
  const [limit, setLimit] = useState(100);
  const labels = useMemo(() => countLabels(persons), [persons]);
  const list = useMemo(() => persons
    .filter((p) => (!label || p.labels.includes(label))
      && matches(q, p.name, idx.org.get(p.org_id)?.name || '', p.emails, p.phones))
    .sort(sort === 'az' ? byName : byUpdatedDesc), [persons, q, label, sort, idx]);

  return html`<div class="page">
    <${PageHead} title="Kontakte" count=${list.length}
      action=${!isMobile && html`<a class="btn primary" href="#/kontakte/neu"><${Icon} n="plus" />Kontakt</a>`} />
    <div class="toolbar">
      <${SearchBox} value=${q} onInput=${setQ} placeholder="Name, Firma, E-Mail, Telefon" />
      <${SortToggle} value=${sort} onChange=${setSort} />
    </div>
    ${labels.length > 0 && html`<${LabelFilter} labels=${labels} value=${label} onChange=${setLabel} />`}
    <div class="list">
      ${list.slice(0, limit).map((p) => html`<${PersonRow} key=${p.id} person=${p} />`)}
      ${list.length > limit && html`<button class="btn ghost full" onClick=${() => setLimit(limit + 200)}>Weitere anzeigen</button>`}
      ${list.length === 0 && html`<p class="muted pad">Keine Kontakte gefunden.</p>`}
    </div>
    ${isMobile && html`<${Fab} href="#/kontakte/neu" label="Neuer Kontakt" />`}
  </div>`;
}

function PersonRow({ person }) {
  const { idx } = useApp();
  const org = idx.org.get(person.org_id);
  const sub = [org?.name, person.phones[0] || person.emails[0]].filter(Boolean).join(' · ');
  return html`<a class="row" href=${`#/kontakt/${person.id}`}>
    <${Avatar} name=${person.name} />
    <div class="row-main"><div class="row-title">${person.name}</div>${sub && html`<div class="row-sub">${sub}</div>`}</div>
    ${person.labels.length > 0 && html`<div class="row-labels">${person.labels.slice(0, 2).map((l) => html`<span class="chip" key=${l}>${l}</span>`)}</div>`}
  </a>`;
}

function PersonPage({ person: p }) {
  const { idx, cards } = useApp();
  if (!p) return html`<${NotFound} what="Kontakt" href="#/kontakte" />`;
  const org = idx.org.get(p.org_id);
  const pcards = cards.filter((c) => c.person_id === p.id);
  const hasProfile = p.ankauf_km != null || p.ankaufsprofil_url;
  return html`<div class="page detail">
    <a class="back" href="#/kontakte"><${Icon} n="back" />Kontakte</a>
    <div class="detail-head">
      <${Avatar} name=${p.name} size="lg" />
      <div class="detail-title">
        <h1>${p.name}</h1>
        ${org && html`<a class="sub-link" href=${`#/firma/${org.id}`}>${org.name}</a>`}
        ${p.labels.length > 0 && html`<div class="chips">${p.labels.map((l) => html`<span class="chip" key=${l}>${l}</span>`)}</div>`}
      </div>
      <a class="btn" href=${`#/kontakt/${p.id}/bearbeiten`}>Bearbeiten</a>
    </div>
    <${ContactActions} phones=${p.phones} emails=${p.emails} />
    ${p.emails.length > 0 && html`<div class="contact-actions">
      <a class="btn" href=${`#/termin/neu?gast=${p.id}`}><${Icon} n="calendar" />Termin einladen</a>
    </div>`}
    <div class="detail-grid">
      <div class="detail-side">
        <${CardsPanel} cards=${pcards} newHref=${`#/karte/neu?kontakt=${p.id}`} />
        <${EventsPanel} personIds=${[p.id]} />
        <${MeetingsPanel} ids=${idx.meetingsOf.get(p.id) || []} />
        ${hasProfile && html`<section class="panel"><h3>Ankaufsprofil</h3><dl class="kv">
          ${p.ankauf_km != null && html`<dt>Entfernung</dt><dd>${Number(p.ankauf_km).toLocaleString('de-DE')} km</dd>`}
          ${p.ankaufsprofil_url && html`<dt>Profil</dt><dd><a href=${safeUrl(p.ankaufsprofil_url)} target="_blank" rel="noopener">Öffnen</a></dd>`}
        </dl></section>`}
        <p class="meta">Angelegt ${fullDate(p.created_at)}</p>
      </div>
      <div class="detail-main">
        <${NotesPanel} filter=${{ person_id: p.id }} defaults=${{ person_id: p.id, org_id: p.org_id }} />
        <${EmailsPanel} personIds=${[p.id]} />
      </div>
    </div>
  </div>`;
}

const cleanList = (l) => l.map((x) => x.trim()).filter(Boolean);

// Löscht Notizen, die nur an diesem Kontakt oder dieser Firma hängen.
async function deleteLooseNotes(filter) {
  const notes = await db.list('notes', filter);
  for (const n of notes.filter((x) => !x.card_id && !(filter.person_id ? x.org_id : x.person_id))) {
    await db.remove('notes', n.id);
  }
}

function PersonForm({ person }) {
  const { organizations, persons, actions, idx } = useApp();
  const [f, setF] = useState(() => ({
    name: person?.name || '',
    org_id: person?.org_id ?? null,
    phones: person?.phones?.length ? [...person.phones] : [''],
    emails: person?.emails?.length ? [...person.emails] : [''],
    labels: [...(person?.labels || [])],
    ankauf_km: person?.ankauf_km ?? '',
    ankaufsprofil_url: person?.ankaufsprofil_url || '',
  }));
  const [busy, setBusy] = useState(false);
  const nameRef = useRef(null);
  useEffect(() => { if (!person) nameRef.current?.focus(); }, []);
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const allLabels = useMemo(() => countLabels(persons).map(([l]) => l), [persons]);
  const close = () => back(person ? `#/kontakt/${person.id}` : '#/kontakte');

  async function submit(e) {
    e.preventDefault();
    if (!f.name.trim()) return;
    setBusy(true);
    const km = String(f.ankauf_km).trim().replace(',', '.');
    const row = {
      name: f.name.trim(),
      org_id: f.org_id,
      phones: cleanList(f.phones),
      emails: cleanList(f.emails),
      labels: f.labels,
      ankauf_km: km === '' || Number.isNaN(Number(km)) ? null : Number(km),
      ankaufsprofil_url: f.ankaufsprofil_url.trim() || null,
    };
    try {
      const saved = await actions.save('persons', person ? { id: person.id, ...row } : row);
      go(`#/kontakt/${saved.id}`, true);
    } catch { /* fail */ } finally { setBusy(false); }
  }
  async function del() {
    if (!confirm(`${person.name} löschen?\nAufgaben bleiben erhalten. Notizen, die nur an diesem Kontakt hängen, werden mit gelöscht.`)) return;
    try {
      await deleteLooseNotes({ person_id: person.id });
      await actions.remove('persons', person.id);
      go('#/kontakte', true);
    } catch (e) { actions.fail(e); }
  }

  return html`<${Sheet} title=${person ? 'Kontakt bearbeiten' : 'Neuer Kontakt'} onClose=${close}>
    <form class="form" onSubmit=${submit}>
      <label class="field"><span>Name</span>
        <input ref=${nameRef} value=${f.name} required autocomplete="off" onInput=${(e) => set('name', e.target.value)} /></label>
      <div class="field"><span>Firma</span>
        <${Combobox} items=${organizations} value=${f.org_id} onChange=${(v) => set('org_id', v)} label=${(o) => o.name}
          placeholder="Firma suchen oder neu anlegen" onCreate=${async (name) => (await actions.save('organizations', { name })).id} /></div>
      <${MultiField} label="Telefon" type="tel" values=${f.phones} onChange=${(v) => set('phones', v)} />
      <${MultiField} label="E-Mail" type="email" values=${f.emails} onChange=${(v) => set('emails', v)} />
      <div class="field"><span>Labels</span><${LabelPicker} all=${allLabels} value=${f.labels} onChange=${(v) => set('labels', v)} /></div>
      <details class="more" open=${f.ankauf_km !== '' || !!f.ankaufsprofil_url}>
        <summary>Ankaufsprofil</summary>
        <div class="field-row">
          <label class="field"><span>Entfernung (km)</span>
            <input inputmode="decimal" value=${f.ankauf_km} onInput=${(e) => set('ankauf_km', e.target.value)} /></label>
          <label class="field grow"><span>Link zum Ankaufsprofil</span>
            <input type="url" value=${f.ankaufsprofil_url} onInput=${(e) => set('ankaufsprofil_url', e.target.value)} /></label>
        </div>
      </details>
      <div class="form-actions">
        <button class="btn primary" disabled=${busy || !f.name.trim()}>${person ? 'Speichern' : 'Anlegen'}</button>
        <button type="button" class="btn ghost" onClick=${close}>Abbrechen</button>
        ${person && idx.ownsRow(person) && html`<span class="spacer"></span><button type="button" class="btn ghost danger" onClick=${del}>Löschen</button>`}
      </div>
    </form>
  <//>`;
}

// ---------------------------------------------------------------------------
// Firmen
// ---------------------------------------------------------------------------
function OrgsList() {
  const { organizations, persons, isMobile } = useApp();
  const [q, setQ] = useStored('crm-q-firmen', '');
  const [label, setLabel] = useStored('crm-l-firmen', '');
  const [sort, setSort] = useStored('crm-s-firmen', 'neu');
  const [limit, setLimit] = useState(100);
  const people = useMemo(() => {
    const m = new Map();
    persons.forEach((p) => { if (p.org_id) m.set(p.org_id, (m.get(p.org_id) || 0) + 1); });
    return m;
  }, [persons]);
  const labels = useMemo(() => countLabels(organizations), [organizations]);
  const list = useMemo(() => organizations
    .filter((o) => (!label || o.labels.includes(label)) && matches(q, o.name, o.website || '', o.address || ''))
    .sort(sort === 'az' ? byName : byUpdatedDesc), [organizations, q, label, sort]);

  return html`<div class="page">
    <${PageHead} title="Firmen" count=${list.length}
      action=${!isMobile && html`<a class="btn primary" href="#/firmen/neu"><${Icon} n="plus" />Firma</a>`} />
    <div class="toolbar">
      <${SearchBox} value=${q} onInput=${setQ} placeholder="Name, Website, Ort" />
      <${SortToggle} value=${sort} onChange=${setSort} />
    </div>
    ${labels.length > 0 && html`<${LabelFilter} labels=${labels} value=${label} onChange=${setLabel} />`}
    <div class="list">
      ${list.slice(0, limit).map((o) => {
    const n = people.get(o.id) || 0;
    const sub = [n ? `${n} Kontakt${n === 1 ? '' : 'e'}` : '', o.address].filter(Boolean).join(' · ');
    return html`<a key=${o.id} class="row" href=${`#/firma/${o.id}`}>
          <${Avatar} name=${o.name} square />
          <div class="row-main"><div class="row-title">${o.name}</div>${sub && html`<div class="row-sub">${sub}</div>`}</div>
          ${o.labels.length > 0 && html`<div class="row-labels">${o.labels.slice(0, 2).map((l) => html`<span class="chip" key=${l}>${l}</span>`)}</div>`}
        </a>`;
  })}
      ${list.length > limit && html`<button class="btn ghost full" onClick=${() => setLimit(limit + 200)}>Weitere anzeigen</button>`}
      ${list.length === 0 && html`<p class="muted pad">Keine Firmen gefunden.</p>`}
    </div>
    ${isMobile && html`<${Fab} href="#/firmen/neu" label="Neue Firma" />`}
  </div>`;
}

function OrgPage({ org: o }) {
  const { persons, cards, idx } = useApp();
  if (!o) return html`<${NotFound} what="Firma" href="#/firmen" />`;
  const people = persons.filter((p) => p.org_id === o.id).sort(byName);
  const ocards = cards.filter((c) => c.org_id === o.id);
  return html`<div class="page detail">
    <a class="back" href="#/firmen"><${Icon} n="back" />Firmen</a>
    <div class="detail-head">
      <${Avatar} name=${o.name} size="lg" square />
      <div class="detail-title">
        <h1>${o.name}</h1>
        ${o.address && html`<div class="sub-link">${o.address}</div>`}
        ${o.labels.length > 0 && html`<div class="chips">${o.labels.map((l) => html`<span class="chip" key=${l}>${l}</span>`)}</div>`}
      </div>
      <a class="btn" href=${`#/firma/${o.id}/bearbeiten`}>Bearbeiten</a>
    </div>
    <div class="contact-actions">
      ${o.website && html`<a class="btn" href=${safeUrl(o.website)} target="_blank" rel="noopener"><${Icon} n="link" />${o.website.replace(/^https?:\/\//, '').replace(/\/$/, '')}</a>`}
      ${o.drive_url && html`<a class="btn" href=${safeUrl(o.drive_url)} target="_blank" rel="noopener"><${Icon} n="link" />Google Drive</a>`}
    </div>
    <div class="detail-grid">
      <div class="detail-side">
        <section class="panel">
          <h3>Kontakte <span class="count">${people.length}</span>
            <a class="icon-btn" href="#/kontakte/neu" title="Kontakt anlegen" aria-label="Kontakt anlegen"><${Icon} n="plus" /></a></h3>
          ${people.map((p) => html`<a key=${p.id} class="row compact" href=${`#/kontakt/${p.id}`}>
            <${Avatar} name=${p.name} /><div class="row-main"><div class="row-title">${p.name}</div>
            ${(p.phones[0] || p.emails[0]) && html`<div class="row-sub">${p.phones[0] || p.emails[0]}</div>`}</div></a>`)}
          ${people.length === 0 && html`<p class="muted small">Keine Kontakte.</p>`}
        </section>
        <${CardsPanel} cards=${ocards} newHref=${`#/karte/neu?firma=${o.id}`} />
        <${EventsPanel} personIds=${people.map((p) => p.id)} />
        <${MeetingsPanel} ids=${people.flatMap((p) => idx.meetingsOf.get(p.id) || [])} />
      </div>
      <div class="detail-main">
        <${NotesPanel} filter=${{ org_id: o.id }} defaults=${{ org_id: o.id }} />
        <${EmailsPanel} personIds=${people.map((p) => p.id)} />
      </div>
    </div>
  </div>`;
}

function OrgForm({ org }) {
  const { organizations, actions, idx } = useApp();
  const [f, setF] = useState(() => ({
    name: org?.name || '',
    website: org?.website || '',
    address: org?.address || '',
    drive_url: org?.drive_url || '',
    labels: [...(org?.labels || [])],
  }));
  const [busy, setBusy] = useState(false);
  const nameRef = useRef(null);
  useEffect(() => { if (!org) nameRef.current?.focus(); }, []);
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const allLabels = useMemo(() => countLabels(organizations).map(([l]) => l), [organizations]);
  const close = () => back(org ? `#/firma/${org.id}` : '#/firmen');

  async function submit(e) {
    e.preventDefault();
    if (!f.name.trim()) return;
    setBusy(true);
    const row = {
      name: f.name.trim(),
      website: f.website.trim() || null,
      address: f.address.trim() || null,
      drive_url: f.drive_url.trim() || null,
      labels: f.labels,
    };
    try {
      const saved = await actions.save('organizations', org ? { id: org.id, ...row } : row);
      go(`#/firma/${saved.id}`, true);
    } catch { /* fail */ } finally { setBusy(false); }
  }
  async function del() {
    if (!confirm(`${org.name} löschen?\nKontakte und Aufgaben bleiben erhalten. Notizen, die nur an der Firma hängen, werden mit gelöscht.`)) return;
    try {
      await deleteLooseNotes({ org_id: org.id });
      await actions.remove('organizations', org.id);
      go('#/firmen', true);
    } catch (e) { actions.fail(e); }
  }

  return html`<${Sheet} title=${org ? 'Firma bearbeiten' : 'Neue Firma'} onClose=${close}>
    <form class="form" onSubmit=${submit}>
      <label class="field"><span>Name</span>
        <input ref=${nameRef} value=${f.name} required autocomplete="off" onInput=${(e) => set('name', e.target.value)} /></label>
      <label class="field"><span>Website</span>
        <input type="url" value=${f.website} placeholder="https://" onInput=${(e) => set('website', e.target.value)} /></label>
      <label class="field"><span>Adresse</span>
        <input value=${f.address} onInput=${(e) => set('address', e.target.value)} /></label>
      <label class="field"><span>Google-Drive-Ordner</span>
        <input type="url" value=${f.drive_url} placeholder="https://drive.google.com/…" onInput=${(e) => set('drive_url', e.target.value)} /></label>
      <div class="field"><span>Labels</span><${LabelPicker} all=${allLabels} value=${f.labels} onChange=${(v) => set('labels', v)} /></div>
      <div class="form-actions">
        <button class="btn primary" disabled=${busy || !f.name.trim()}>${org ? 'Speichern' : 'Anlegen'}</button>
        <button type="button" class="btn ghost" onClick=${close}>Abbrechen</button>
        ${org && idx.ownsRow(org) && html`<span class="spacer"></span><button type="button" class="btn ghost danger" onClick=${del}>Löschen</button>`}
      </div>
    </form>
  <//>`;
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
applyTheme(ls.get('crm-theme') || '');
const root = document.getElementById('app');
root.textContent = '';
render(html`<${App} />`, root);

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(() => {}); });
}
