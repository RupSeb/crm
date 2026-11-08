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

async function googleCall(path, body) {
  return functionCall('google-abgleich', path, body);
}

// Edge Function mit dem eigenen Login aufrufen
async function functionCall(name, path, body) {
  const c = await client();
  const session = check(await c.auth.getSession()).session;
  const res = await fetch(`${SUPABASE_URL}/functions/v1/${name}/${path}`, {
    method: 'POST',
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${session?.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || data.message || `Fehler ${res.status}`);
  return data;
}

// Anmeldeserver direkt ansprechen, die eingebundene supabase.js kennt die OAuth-Freigabe noch nicht
async function oauthCall(method, path, body) {
  const c = await client();
  const session = check(await c.auth.getSession()).session;
  const res = await fetch(`${SUPABASE_URL}/auth/v1/oauth/${path}`, {
    method,
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${session?.access_token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.msg || data.message || data.error_description || `Fehler ${res.status}`);
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
  // Google-Konto verbinden und abgleichen (Edge Function google-abgleich)
  // Erinnerung sofort an die eigenen Geräte schicken (Funktion „erinnerung“)
  async pushTest() {
    return functionCall('erinnerung', 'test', {});
  },
  async googleStart(address, senden = false) {
    return (await googleCall('start', { address, senden })).url;
  },
  async googleSync() {
    return googleCall('sync', {});
  },
  // Mails verschicken: Postfächer mit Senderecht und das Senden selbst (nur mit Login der App)
  async mailAbsender() {
    return (await googleCall('absender', {})).konten || [];
  },
  async mailSend(mail) {
    return googleCall('senden', mail);
  },
  // Termine direkt im eigenen Kalender anlegen und absagen
  async termin(t) {
    return googleCall('termin', t);
  },
  // Link auf einen Anhang, 5 Minuten gültig
  async mailAnhang(emailId, name, nr) {
    return googleCall('anhang-link', { email_id: emailId, name, nr });
  },
  async terminAbsagen(t) {
    return googleCall('termin-absagen', t);
  },
  // Freigabe für Claude: Supabase ist der Anmeldeserver, diese Seite fragt nur nach Erlaubnis
  async oauthDetails(id) {
    return oauthCall('GET', `authorizations/${encodeURIComponent(id)}`);
  },
  async oauthDecide(id, approve) {
    const d = await oauthCall('POST', `authorizations/${encodeURIComponent(id)}/consent`, { action: approve ? 'approve' : 'deny' });
    return d.redirect_url;
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
  // Postfach: Mails seitenweise, neueste zuerst. before = sent_at der ältesten schon geladenen Mail.
  // view: 'inbox' (liegt in Gmail im Posteingang), 'out' (gesendet) oder '' (alle)
  async mails({ mailbox = '', view = '', text = '', before = null, limit = 50, columns = '*' } = {}) {
    const c = await client();
    let q = c.from('emails').select(columns).order('sent_at', { ascending: false }).order('id', { ascending: false }).limit(limit);
    if (mailbox) q = q.eq('mailbox', mailbox);
    if (view === 'inbox') q = q.eq('in_inbox', true);
    if (view === 'out') q = q.eq('direction', 'out');
    if (before) q = q.lt('sent_at', before);
    const t = text.replace(/[,()*%"\\]/g, ' ').replace(/\s+/g, ' ').trim();
    if (t) q = q.or(['subject', 'from_name', 'from_email', 'body'].map((f) => `${f}.ilike."*${t}*"`).join(','));
    return check(await q);
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
  // Einfügen oder bei vorhandenem Schlüssel ersetzen (z. B. „zuletzt gesehen“)
  async upsert(table, row, onConflict) {
    const c = await client();
    return check(await c.from(table).upsert(row, { onConflict }).select().single());
  },
  // Dateien im privaten Storage-Bucket „dateien“, Pfad karten/<id>/<datei>
  async listFiles(prefix) {
    const c = await client();
    const list = check(await c.storage.from('dateien').list(prefix, { limit: 200, sortBy: { column: 'created_at', order: 'desc' } }));
    return list.filter((f) => f.id && f.name !== '.emptyFolderPlaceholder');
  },
  async uploadFile(path, file) {
    const c = await client();
    check(await c.storage.from('dateien').upload(path, file, { contentType: file.type || 'application/octet-stream' }));
  },
  // Kurzlebiger Link (10 Minuten), der Bucket selbst ist nicht öffentlich
  async fileUrl(path) {
    const c = await client();
    return check(await c.storage.from('dateien').createSignedUrl(path, 600)).signedUrl;
  },
  async removeFile(path) {
    const c = await client();
    check(await c.storage.from('dateien').remove([path]));
  },
  async remove(table, id) {
    const c = await client();
    check(await c.from(table).delete().eq('id', id));
  },
};

// ---------------------------------------------------------------------------
// Demo
// ---------------------------------------------------------------------------
const KEY = 'crm-demo-v9';
const TABLES = ['projects', 'stages', 'organizations', 'persons', 'cards', 'notes', 'meetings', 'meeting_persons',
  'emails', 'email_persons', 'events', 'event_persons', 'card_shares', 'project_shares', 'card_events', 'card_seen',
  'nachfass_aus', 'nutzer_gesehen', 'nutzer_einstellungen', 'aktivitaeten', 'verkauf'];
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

const demoFiles = new Map();

// Verlauf wie die Trigger in supabase/05_team.sql
const CARD_LOG = [['stage_id', 'spalte'], ['priority', 'dringlichkeit'], ['due_date', 'faellig'], ['assignee', 'zustaendig'],
  ['title', 'titel'], ['project_id', 'projekt'], ['archived', 'archiv']];
function logDemo(cardId, kind, detail) {
  const s = state();
  s.seq += 1;
  s.card_events.push({ id: s.seq, card_id: cardId, at: now(), actor: DEMO_GUEST ? 'gast@beispiel.de' : 'demo@beispiel.de', kind, detail: detail ?? null });
}
function logDemoUpdate(before, after) {
  const s = state();
  CARD_LOG.forEach(([field, kind]) => {
    if ((before[field] ?? null) === (after[field] ?? null)) return;
    const v = after[field];
    const detail = field === 'stage_id' ? s.stages.find((x) => x.id === v)?.name
      : field === 'project_id' ? s.projects.find((x) => x.id === v)?.name
        : field === 'archived' ? (v ? 'ja' : 'nein') : v;
    logDemo(after.id, kind, detail);
  });
}

// Postfach-Ansicht einer Mail. Demo-Mails haben keinen Posteingangs-Merker, eingehende gelten dort als im Posteingang.
export const matchesView = (m, view) => (view === 'inbox' ? (m.in_inbox ?? m.direction === 'in')
  : view === 'out' ? m.direction === 'out' : true);

// Demo: dieselben Regeln wie supabase/27_nachfass.sql
const t = (iso) => new Date(iso).getTime();
const lc = (a) => String(a || '').toLowerCase();
function demoAntworten() {
  const s = state();
  return s.cards.flatMap((c) => {
    const st = s.stages.find((x) => x.id === c.stage_id);
    if (c.archived || !st || st.is_done || !lc(st.name).startsWith('feedback')) return [];
    const people = c.person_id ? s.persons.filter((p) => p.id === c.person_id) : s.persons.filter((p) => c.org_id && p.org_id === c.org_id);
    const addrs = people.flatMap((p) => (p.emails || []).map(lc));
    if (!addrs.length) return [];
    const m = s.emails.filter((e) => e.direction === 'in' && addrs.includes(lc(e.from_email)) && t(e.sent_at) > t(c.updated_at))
      .sort((a, b) => t(b.sent_at) - t(a.sent_at))[0];
    if (!m) return [];
    const replied = s.emails.some((x) => x.direction === 'out' && t(x.sent_at) > t(m.sent_at)
      && [...x.to_emails, ...x.cc_emails].some((y) => addrs.includes(lc(y))));
    return replied ? [] : [{ card_id: c.id, email_id: m.id, sent_at: m.sent_at, from_name: m.from_name, from_email: m.from_email, subject: m.subject, mailbox: m.mailbox }];
  });
}
function demoOhneAntwort(tage) {
  const s = state();
  const eigene = new Set(s.emails.map((e) => lc(e.mailbox)));
  const last = new Map();
  s.emails.filter((e) => t(e.sent_at) > Date.now() - 60 * 864e5).forEach((e) => {
    const k = e.mailbox + '|' + (e.thread_id || e.message_id);
    if (!last.has(k) || t(e.sent_at) > t(last.get(k).sent_at)) last.set(k, e);
  });
  return [...last.values()].filter((m) => {
    const an = [...m.to_emails, ...m.cc_emails].map(lc);
    const key = m.thread_id || m.message_id;
    return m.direction === 'out' && t(m.sent_at) < Date.now() - tage * 864e5 && an.some((a) => !eigene.has(a))
      && !s.emails.some((i) => i.direction === 'in' && t(i.sent_at) > t(m.sent_at) && an.includes(lc(i.from_email)))
      && !s.nachfass_aus.some((n) => n.mailbox === m.mailbox && n.thread_key === key && t(n.at) >= t(m.sent_at));
  }).map((m) => ({ ...copy(m), thread_key: m.thread_id || m.message_id, body: undefined }))
    .sort((a, b) => t(b.sent_at) - t(a.sent_at));
}
function demoGesehen() {
  return state().nutzer_gesehen.find((g) => g.bereich === 'postfach');
}
// Wie die Trigger in supabase/29_aktivitaeten.sql: Aktivität am Deal zählt als Änderung und kommt in den Verlauf.
// Deal nach „Feedback …“ ohne offene Aktivität und ohne Datum: Wiedervorlage in 7 Tagen.
function demoAktLog(a, before) {
  if (!a.card_id) return;
  touch('cards', a.card_id);
  if (!before) logDemo(a.card_id, 'aktivitaet', `${a.art}|${a.faellig}|${a.titel || ''}`);
  else if (a.erledigt_at && !before.erledigt_at) logDemo(a.card_id, 'aktivitaet_erledigt', `${a.art}|${a.titel || ''}`);
  else if (a.faellig !== before.faellig && !a.erledigt_at) logDemo(a.card_id, 'aktivitaet_verschoben', `${a.art}|${a.faellig}|${a.titel || ''}`);
}
function demoFeedback(card, before) {
  const s = state();
  const st = s.stages.find((x) => x.id === card.stage_id);
  if ((before && before.stage_id === card.stage_id) || card.archived || card.due_date || !st || !lc(st.name).startsWith('feedback')) return;
  if (s.aktivitaeten.some((a) => a.card_id === card.id && !a.erledigt_at)) return;
  const d = new Date(Date.now() + 7 * 864e5);
  s.seq += 1;
  const a = { id: s.seq, owner: 'demo@beispiel.de', card_id: card.id, person_id: null, org_id: null, art: 'wiedervorlage', titel: null,
    faellig: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
    uhrzeit: null, zustaendig: null, erledigt_at: null, erledigt_von: null, created_at: now(), updated_at: now() };
  s.aktivitaeten.push(a);
  demoAktLog(a, null);
}

// Wie die Trigger in supabase/32_verkauf.sql: Abschlussdatum und Verlustgrund sauber halten, Verlauf am Deal
function demoVerkauf(r, before) {
  const heute = new Date();
  const tag = `${heute.getFullYear()}-${String(heute.getMonth() + 1).padStart(2, '0')}-${String(heute.getDate()).padStart(2, '0')}`;
  r.status = r.status || 'offen';
  r.verlustgrund = String(r.verlustgrund || '').trim() || null;
  if (r.status === 'offen') { r.abgeschlossen_am = null; r.verlustgrund = null; } else {
    if (r.status !== 'verloren') r.verlustgrund = null;
    if (before && r.status !== before.status && (r.abgeschlossen_am ?? null) === (before.abgeschlossen_am ?? null)) r.abgeschlossen_am = tag;
    r.abgeschlossen_am = r.abgeschlossen_am || tag;
  }
  if (r.wert === '' || r.wert === undefined) r.wert = null;
  const w = (x) => (x === null || x === undefined ? '' : String(Number(x)));
  if (!before) {
    if (r.wert !== null) logDemo(r.card_id, 'verkauf_wert', '|' + w(r.wert));
    logDemo(r.card_id, 'verkauf_status', `${r.status}|${r.verlustgrund || ''}`);
    return;
  }
  if (w(r.wert) !== w(before.wert)) logDemo(r.card_id, 'verkauf_wert', `${w(before.wert)}|${w(r.wert)}`);
  if (r.status !== before.status || (r.status === 'verloren' && r.verlustgrund !== before.verlustgrund)) {
    logDemo(r.card_id, 'verkauf_status', `${r.status}|${r.verlustgrund || ''}`);
  }
}

let demoKonten = [
  { id: 1, address: 'demo@beispiel.de', status: 'ok', fehler: null, letzter_lauf: now(), mails: 2, termine: 5, darf_senden: true, darf_termine: true },
  { id: 2, address: 'team@beispiel.de', status: 'ok', fehler: null, letzter_lauf: now(), mails: 0, termine: 0, darf_senden: false, darf_termine: false },
];

const demo = {
  async session() { return { user: { email: DEMO_GUEST ? 'gast@beispiel.de' : 'demo@beispiel.de' } }; },
  async onAuth() {},
  async signIn() { return demo.session(); },
  async signUp() { return demo.session(); },
  async pushTest() { throw new Error('Im Demo-Modus gibt es keine Mitteilungen.'); },
  async resetPassword() {},
  async setPassword() { return demo.session(); },
  async mfaState() { return { current: 'aal2', verified: [{ id: 'demo' }] }; },
  async mfaEnroll() { return { factorId: 'demo', qr: '', secret: 'DEMO', uri: '' }; },
  async mfaVerify() {},
  async mfaRemoveOthers() {},
  async oauthDetails() { return { client: { name: 'Claude' }, redirect_uri: 'https://claude.ai/api/mcp/auth_callback' }; },
  async oauthDecide() { return location.pathname + location.search; },
  async rpc(fn, args = {}) {
    if (fn === 'my_role') return DEMO_GUEST ? 'gast' : 'owner';
    if (fn === 'crm_users') return DEMO_USERS;
    if (fn === 'log_file') { logDemo(args.cid, 'datei', args.fname); persist(); }
    if (fn === 'meine_google_konten') return DEMO_GUEST ? [] : demoKonten.map(copy);
    if (fn === 'google_konto_trennen') demoKonten = demoKonten.filter((k) => k.id !== args.kid);
    if (DEMO_GUEST && ['antworten_offen', 'mails_ohne_antwort'].includes(fn)) return [];
    if (fn === 'antworten_offen') return demoAntworten();
    if (fn === 'mails_ohne_antwort') return demoOhneAntwort(args.p_tage ?? 3);
    if (fn === 'postfach_neu') {
      const g = demoGesehen();
      return g && !DEMO_GUEST ? state().emails.filter((e) => e.direction === 'in' && (e.in_inbox ?? true)
        && t(e.created_at) > t(g.at) && t(e.sent_at) > t(g.at) - 864e5).length : 0;
    }
    if (fn === 'postfach_gesehen') {
      const g = demoGesehen();
      const vorher = g?.at ?? null;
      state().nutzer_gesehen = [...state().nutzer_gesehen.filter((x) => x !== g), { id: 1, bereich: 'postfach', at: now() }];
      persist();
      return vorher;
    }
    return null;
  },
  // Postfächer und Senden: nur im Speicher dieses Tabs, verschickt wird nichts
  async googleStart(address, senden = false) {
    demoKonten = demoKonten.map((k) => (k.address === address ? { ...k, darf_senden: senden, darf_termine: senden } : k));
    return location.href;
  },
  async googleSync() { return { ok: true }; },
  async mailAbsender() {
    return demoKonten.filter((k) => k.darf_senden)
      .map((k) => ({ address: k.address, name: 'Alex Demo', signatur: 'Alex Demo\nMusterfirma GmbH' }));
  },
  async mailSend(mail) {
    const s = state();
    const liste = (x) => (String(x || '').match(/[^\s,;<>"]+@[^\s,;<>"]+/g) || []).map((a) => a.toLowerCase());
    const an = liste(mail.an);
    s.seq += 1;
    const m = {
      id: s.seq, message_id: `<demo-${s.seq}@beispiel.de>`, thread_id: null, mailbox: mail.von, gmail_id: null, direction: 'out',
      from_email: mail.von, from_name: 'Alex Demo', to_emails: an, cc_emails: liste(mail.cc), subject: mail.betreff, sent_at: now(),
      body: mail.text, attachments: (mail.anhaenge || []).map((a) => a.name), in_inbox: false, created_at: now(),
    };
    s.emails.push(m);
    s.persons.filter((p) => (p.emails || []).some((e) => an.includes(e.toLowerCase()))).forEach((p) => {
      s.seq += 1;
      s.email_persons.push({ id: s.seq, email_id: m.id, person_id: p.id });
    });
    persist();
    return { ok: true };
  },
  async termin(t) {
    const s = state();
    s.seq += 1;
    const gaeste = t.gaeste || [];
    s.events.push({
      id: s.seq, calendar_id: t.von, calendar_name: 'Demo', calendar_color: '#7fa7c9', event_id: `demo${s.seq}`, ical_uid: `demo${s.seq}`,
      title: t.titel, start_at: t.start, end_at: t.ende, all_day: false, location: t.ort || null, meet_url: t.meet ? 'https://meet.google.com/demo' : null,
      html_link: null, attendees: gaeste, organizer: t.von, description: t.beschreibung || null, status: 'confirmed', updated_at: now(),
    });
    persist();
    return { ok: true };
  },
  async mailAnhang(emailId, name) {
    return { url: URL.createObjectURL(new Blob([`Beispiel für den Anhang ${name} im Demo-Modus.`], { type: 'text/plain' })) };
  },
  async terminAbsagen(t) {
    const s = state();
    s.events = s.events.filter((e) => !(e.calendar_id === t.von && e.event_id === t.event_id));
    persist();
    return { ok: true };
  },
  // Dateien nur im Speicher dieses Tabs
  async listFiles(prefix) {
    return [...demoFiles.entries()].filter(([path]) => path.startsWith(prefix + '/'))
      .map(([path, f]) => ({ id: path, name: path.slice(prefix.length + 1), created_at: f.created_at, metadata: { size: f.file.size } }))
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  },
  async uploadFile(path, file) { demoFiles.set(path, { file, created_at: now() }); },
  async fileUrl(path) { return URL.createObjectURL(demoFiles.get(path).file); },
  async removeFile(path) { demoFiles.delete(path); },
  async signOut() {
    try { localStorage.removeItem(KEY); } catch { /* egal */ }
    location.reload();
  },
  async list(table, filter = {}) {
    if (DEMO_GUEST && table === 'verkauf') return [];
    return state()[table]
      .filter((r) => Object.entries(filter).every(([k, v]) => r[k] === v))
      .filter((r) => !(DEMO_GUEST && table === 'card_events' && String(r.kind).startsWith('verkauf')))
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
  async mails({ mailbox = '', view = '', text = '', before = null, limit = 50 } = {}) {
    const t = text.toLowerCase().trim();
    return state().emails
      .filter((m) => (!mailbox || m.mailbox === mailbox) && matchesView(m, view)
        && (!before || m.sent_at < before)
        && (!t || ['subject', 'from_name', 'from_email', 'body'].some((f) => String(m[f] || '').toLowerCase().includes(t))))
      .sort((a, b) => (a.sent_at < b.sent_at ? 1 : -1))
      .slice(0, limit)
      .map(copy);
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
    if (table === 'notes') {
      touch('cards', r.card_id);
      touch('persons', r.person_id);
      if (r.card_id && !r.private) {
        logDemo(r.card_id, 'notiz');
        (r.mentions || []).forEach((m) => logDemo(r.card_id, 'erwaehnung', m.toLowerCase()));
      }
    }
    if (table === 'cards') { logDemo(r.id, 'angelegt'); demoFeedback(r, null); }
    if (table === 'aktivitaeten') demoAktLog(r, null);
    persist();
    return copy(r);
  },
  async update(table, id, patch) {
    const r = state()[table].find((x) => x.id === id);
    if (!r) throw new Error('Eintrag nicht gefunden');
    const before = { ...r };
    Object.assign(r, patch, { updated_at: now() });
    if (table === 'cards') { logDemoUpdate(before, r); demoFeedback(r, before); }
    if (table === 'aktivitaeten') demoAktLog(r, before);
    if (table === 'verkauf') demoVerkauf(r, before);
    persist();
    return copy(r);
  },
  // Wie in PostgREST: nur die mitgeschickten Spalten ändern sich, der Rest bleibt
  async upsert(table, row, onConflict) {
    const s = state();
    const keys = onConflict.split(',');
    const old = s[table].find((x) => keys.every((k) => x[k] === row[k]));
    s[table] = s[table].filter((x) => x !== old);
    if (!old) s.seq += 1;
    const r = { ...(old || { created_at: now() }), id: old?.id ?? s.seq, ...row, updated_at: now() };
    if (table === 'verkauf') demoVerkauf(r, old || null);
    s[table].push(r);
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
      s.card_events = s.card_events.filter((x) => x.card_id !== id);
      s.card_seen = s.card_seen.filter((x) => x.card_id !== id);
      s.aktivitaeten = s.aktivitaeten.filter((x) => x.card_id !== id);
      s.verkauf = s.verkauf.filter((x) => x.card_id !== id);
    }
    if (table === 'persons') unlink('aktivitaeten', 'person_id');
    if (table === 'organizations') unlink('aktivitaeten', 'org_id');
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
