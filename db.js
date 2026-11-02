// Datenzugriff. Zwei Varianten mit derselben Schnittstelle:
// Supabase (echte Daten) oder Demo (Beispieldaten im localStorage).
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';
import { demoSeed } from './demo.js';

// Demo-Modus: ohne Zugangsdaten oder zum Ausprobieren mit ?demo in der Adresse
export const DEMO = !SUPABASE_URL || !SUPABASE_ANON_KEY || new URLSearchParams(location.search).has('demo');

// ---------------------------------------------------------------------------
// Supabase
// ---------------------------------------------------------------------------
let sb = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Konnte ' + src + ' nicht laden'));
    document.head.appendChild(s);
  });
}

async function client() {
  if (sb) return sb;
  await loadScript('vendor/supabase.js');
  // detectSessionInUrl: Links aus Bestätigungs- und Passwort-Mails melden direkt an
  sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
  return sb;
}

function check({ data, error }) {
  if (error) throw new Error(error.message);
  return data;
}

const remote = {
  async session() {
    const c = await client();
    return check(await c.auth.getSession()).session;
  },
  async onAuth(cb) {
    const c = await client();
    c.auth.onAuthStateChange((event, session) => cb(session, event));
  },
  async signIn(email, password) {
    const c = await client();
    return check(await c.auth.signInWithPassword({ email, password })).session;
  },
  // Liefert eine Sitzung oder null, wenn erst der Link in der Bestätigungsmail nötig ist
  async signUp(email, password) {
    const c = await client();
    const back = location.origin + location.pathname;
    return check(await c.auth.signUp({ email, password, options: { emailRedirectTo: back } })).session;
  },
  async resetPassword(email) {
    const c = await client();
    check(await c.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname }));
  },
  async setPassword(password) {
    const c = await client();
    check(await c.auth.updateUser({ password }));
    return remote.session();
  },
  // Zwei-Faktor (TOTP): Stufe der Anmeldung und eingerichtete Faktoren
  async mfaState() {
    const c = await client();
    const aal = check(await c.auth.mfa.getAuthenticatorAssuranceLevel());
    const f = check(await c.auth.mfa.listFactors());
    return { current: aal.currentLevel, verified: f.totp || [] };
  },
  async mfaEnroll() {
    const c = await client();
    // Abgebrochene Einrichtungen aufräumen, sonst lehnt Supabase eine neue ab
    const f = check(await c.auth.mfa.listFactors());
    for (const x of (f.all || []).filter((x) => x.factor_type === 'totp' && x.status !== 'verified')) {
      await c.auth.mfa.unenroll({ factorId: x.id });
    }
    const d = check(await c.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'CRM ' + new Date().toISOString().slice(0, 16) }));
    return { factorId: d.id, qr: d.totp.qr_code, secret: d.totp.secret, uri: d.totp.uri };
  },
  async mfaVerify(factorId, code) {
    const c = await client();
    check(await c.auth.mfa.challengeAndVerify({ factorId, code }));
  },
  // Nach einem neu bestätigten Faktor alle anderen entfernen (geht nur mit zweitem Faktor angemeldet)
  async mfaRemoveOthers(keepId) {
    const c = await client();
    const f = check(await c.auth.mfa.listFactors());
    for (const x of (f.all || []).filter((x) => x.id !== keepId)) {
      check(await c.auth.mfa.unenroll({ factorId: x.id }));
    }
  },
  async signOut() {
    const c = await client();
    await c.auth.signOut();
  },
  // Datenbank-Funktionen (my_role, crm_users)
  async rpc(fn, args = {}) {
    const c = await client();
    return check(await c.rpc(fn, args));
  },
  async list(table, filter = {}, columns = '*') {
    const c = await client();
    const out = [];
    for (let from = 0; ; from += 1000) {
      let q = c.from(table).select(columns).order('id').range(from, from + 999);
      for (const [k, v] of Object.entries(filter)) q = q.eq(k, v);
      const rows = check(await q);
      out.push(...rows);
      if (rows.length < 1000) return out;
    }
  },
  async get(table, id) {
    const c = await client();
    return check(await c.from(table).select('*').eq('id', id).single());
  },
  // Zeilen, deren Spalte in einer Liste von Werten liegt (in Paketen)
  async listIn(table, column, values, columns = '*') {
    const c = await client();
    const out = [];
    for (let i = 0; i < values.length; i += 200) {
      out.push(...check(await c.from(table).select(columns).in(column, values.slice(i, i + 200)).limit(5000)));
    }
    return out;
  },
  // Volltextsuche in einer Spalte: alle Wörter müssen vorkommen. Liefert nur IDs.
  async searchText(table, column, text) {
    const c = await client();
    let q = c.from(table).select('id');
    for (const w of text.split(/\s+/).filter(Boolean)) q = q.ilike(column, `%${w}%`);
    return check(await q.limit(500));
  },
  async insert(table, row) {
    const c = await client();
    return check(await c.from(table).insert(row).select().single());
  },
  async update(table, id, patch) {
    const c = await client();
    return check(await c.from(table).update(patch).eq('id', id).select().single());
  },
  async remove(table, id) {
    const c = await client();
    check(await c.from(table).delete().eq('id', id));
  },
};

// ---------------------------------------------------------------------------
// Demo
// ---------------------------------------------------------------------------
const KEY = 'crm-demo-v4';
const TABLES = ['projects', 'stages', 'organizations', 'persons', 'cards', 'notes', 'meetings', 'meeting_persons',
  'emails', 'email_persons', 'events', 'event_persons', 'card_shares'];
// Zum Ausprobieren der Gast-Ansicht: ?demo&gast in der Adresse
const DEMO_GUEST = new URLSearchParams(location.search).has('gast');
const DEMO_USERS = [
  { email: 'demo@beispiel.de', name: 'Alex Demo', role: 'owner' },
  { email: 'gast@beispiel.de', name: 'Gerd Gast', role: 'gast' },
];
let mem = null;

function state() {
  if (mem) return mem;
  try { mem = JSON.parse(localStorage.getItem(KEY)); } catch { mem = null; }
  if (!mem) mem = demoSeed();
  for (const t of TABLES) mem[t] = mem[t] || [];
  return mem;
}

function persist() {
  try { localStorage.setItem(KEY, JSON.stringify(mem)); } catch { /* privates Fenster */ }
}

const now = () => new Date().toISOString();
const copy = (r) => JSON.parse(JSON.stringify(r));

// Bildet nach, was die Datenbank mit Fremdschlüsseln und Triggern macht.
function touch(table, id) {
  const r = id && state()[table].find((x) => x.id === id);
  if (r) r.updated_at = now();
}

const demo = {
  async session() { return { user: { email: DEMO_GUEST ? 'gast@beispiel.de' : 'demo@beispiel.de' } }; },
  async onAuth() {},
  async signIn() { return demo.session(); },
  async signUp() { return demo.session(); },
  async resetPassword() {},
  async setPassword() { return demo.session(); },
  async mfaState() { return { current: 'aal2', verified: [{ id: 'demo' }] }; },
  async mfaEnroll() { return { factorId: 'demo', qr: '', secret: 'DEMO', uri: '' }; },
  async mfaVerify() {},
  async mfaRemoveOthers() {},
  async rpc(fn) {
    if (fn === 'my_role') return DEMO_GUEST ? 'gast' : 'owner';
    if (fn === 'crm_users') return DEMO_USERS;
    return null;
  },
  async signOut() {
    try { localStorage.removeItem(KEY); } catch { /* egal */ }
    location.reload();
  },
  async list(table, filter = {}) {
    return state()[table]
      .filter((r) => Object.entries(filter).every(([k, v]) => r[k] === v))
      .map(copy);
  },
  async get(table, id) {
    const r = state()[table].find((x) => x.id === id);
    if (!r) throw new Error('Eintrag nicht gefunden');
    return copy(r);
  },
  async listIn(table, column, values) {
    const set = new Set(values);
    return state()[table].filter((r) => set.has(r[column])).map(copy);
  },
  async searchText(table, column, text) {
    const words = text.toLowerCase().split(/\s+/).filter(Boolean);
    return state()[table]
      .filter((r) => words.every((w) => String(r[column] || '').toLowerCase().includes(w)))
      .map((r) => ({ id: r.id }));
  },
  async insert(table, row) {
    const s = state();
    s.seq += 1;
    const r = { id: s.seq, created_at: now(), updated_at: now(), ...(table === 'notes' ? { private: false, author: DEMO_GUEST ? 'gast@beispiel.de' : 'demo@beispiel.de' } : {}), ...row };
    s[table].push(r);
    if (table === 'notes') { touch('cards', r.card_id); touch('persons', r.person_id); }
    persist();
    return copy(r);
  },
  async update(table, id, patch) {
    const r = state()[table].find((x) => x.id === id);
    if (!r) throw new Error('Eintrag nicht gefunden');
    Object.assign(r, patch, { updated_at: now() });
    persist();
    return copy(r);
  },
  async remove(table, id) {
    const s = state();
    s[table] = s[table].filter((x) => x.id !== id);
    const unlink = (t, key) => s[t].forEach((r) => { if (r[key] === id) r[key] = null; });
    if (table === 'cards') {
      s.notes = s.notes.filter((n) => n.card_id !== id);
      s.card_shares = s.card_shares.filter((x) => x.card_id !== id);
    }
    if (table === 'persons') {
      unlink('cards', 'person_id');
      unlink('notes', 'person_id');
      s.meeting_persons = s.meeting_persons.filter((l) => l.person_id !== id);
      s.email_persons = s.email_persons.filter((l) => l.person_id !== id);
    }
    if (table === 'organizations') { unlink('persons', 'org_id'); unlink('cards', 'org_id'); unlink('notes', 'org_id'); }
    if (table === 'meetings') s.meeting_persons = s.meeting_persons.filter((l) => l.meeting_id !== id);
    if (table === 'projects') {
      unlink('meetings', 'project_id');
      const cardIds = new Set(s.cards.filter((c) => c.project_id === id).map((c) => c.id));
      s.stages = s.stages.filter((x) => x.project_id !== id);
      s.cards = s.cards.filter((c) => c.project_id !== id);
      s.notes = s.notes.filter((n) => !cardIds.has(n.card_id));
    }
    persist();
  },
};

export const db = DEMO ? demo : remote;
