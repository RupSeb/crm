// Beispieldaten für den Demo-Modus. Alle Namen, Firmen und Themen sind erfunden.
export const STAGE_NAMES = ['To-Dos', 'Feedback von Anderen', 'Zukünftig', 'Ongoing', 'Erledigt'];

export function demoSeed() {
  const ago = (days, hours = 0) => new Date(Date.now() - (days * 24 + hours) * 3600e3).toISOString();
  let seq = 0;
  const id = () => ++seq;
  const s = {
    projects: [], stages: [], organizations: [], persons: [], cards: [], notes: [],
    meetings: [], meeting_persons: [], emails: [], email_persons: [], events: [], event_persons: [], card_shares: [],
  };

  const projects = [['Vertrieb', '#7fa7c9'], ['Objekte', '#d98b4f'], ['Allgemein', '#a9b4ae'], ['Kooperationen', '#b08fd6']];
  const stageOf = {};
  projects.forEach(([name, color], i) => {
    const p = { id: id(), name, color, sort: i, created_at: ago(90) };
    s.projects.push(p);
    stageOf[name] = STAGE_NAMES.map((n, j) => {
      const st = { id: id(), project_id: p.id, name: n, sort: j, is_done: n === 'Erledigt' };
      s.stages.push(st);
      return st;
    });
  });

  const org = (name, extra = {}) => {
    const o = { id: id(), name, website: null, address: null, drive_url: null, labels: [], created_at: ago(80), updated_at: ago(10), ...extra };
    s.organizations.push(o);
    return o;
  };
  const musterfirma = org('Musterfirma Nord GmbH', { website: 'https://example.org', address: 'Hauptstraße 1, 12345 Musterstadt' });
  const handel = org('Beispiel Handel AG', { labels: ['Kunde'] });
  const kanzlei = org('Kanzlei Beispiel & Partner');
  const partner = org('Partner Süd GmbH', { labels: ['Partner'] });

  const person = (name, o, extra = {}) => {
    const p = {
      id: id(), name, org_id: o?.id ?? null, emails: [], phones: [], labels: [],
      ankauf_km: null, ankaufsprofil_url: null, created_at: ago(60), updated_at: ago(5), ...extra,
    };
    s.persons.push(p);
    return p;
  };
  const anna = person('Anna Beispiel', musterfirma, { emails: ['anna.beispiel@example.org'], phones: ['+49 151 00000001'], updated_at: ago(0, 3) });
  const ben = person('Ben Muster', handel, { phones: ['+49 89 0000002'], labels: ['Kunde'] });
  const clara = person('Clara Probe', kanzlei, { emails: ['clara@example.com'] });
  const david = person('David Test', partner, { emails: ['d.test@example.net'], phones: ['+49 170 0000004'], updated_at: ago(1) });
  const eva = person('Eva Probst', null, { labels: ['Interessent'], ankauf_km: 50, ankaufsprofil_url: 'https://example.org/profil/eva', phones: ['+49 160 0000005'] });
  const frank = person('Frank Platzhalter', null, { labels: ['Interessent'], ankauf_km: 30, updated_at: ago(12) });

  const inDays = (n) => {
    const d = new Date(Date.now() + n * 864e5);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const card = (title, project, stageName, p, days, extra = {}) => {
    const st = stageOf[project].find((x) => x.name === stageName);
    const c = {
      id: id(), title, project_id: st.project_id, stage_id: st.id,
      person_id: p?.id ?? null, org_id: p?.org_id ?? null, archived: false,
      priority: null, due_date: null, meeting_id: null,
      created_at: ago(days + 5), updated_at: ago(days), ...extra,
    };
    s.cards.push(c);
    return c;
  };
  const angebot = card('Angebot Kundenportal schreiben', 'Vertrieb', 'To-Dos', anna, 0, { priority: 'hoch', due_date: inDays(0) });
  card('Präsentation aktualisiert zuschicken', 'Kooperationen', 'To-Dos', david, 1, { priority: 'mittel', due_date: inDays(2) });
  const rahmen = card('Rahmenvertrag – Rückmeldung?', 'Kooperationen', 'Feedback von Anderen', david, 2);
  card('Rollout Kundenportal', 'Vertrieb', 'Ongoing', anna, 4);
  card('Kooperation Region Süd', 'Kooperationen', 'Zukünftig', null, 20);
  card('Termin Musterfirma vorbereiten', 'Vertrieb', 'Erledigt', anna, 6);
  const vertrag = card('Mietvertrag – Feedback?', 'Objekte', 'Feedback von Anderen', clara, 3);
  card('Rechnung Software prüfen', 'Allgemein', 'To-Dos', null, 2, { due_date: inDays(-2) });
  card('Rückfragen Anwalt klären', 'Objekte', 'Erledigt', clara, 7);
  card('Exposé Wohnung Musterstadt schicken', 'Objekte', 'To-Dos', eva, 1, { priority: 'hoch' });
  card('Finanzierung klären', 'Objekte', 'Ongoing', frank, 9, { due_date: inDays(10) });
  card('Neue Zielgruppe testen', 'Vertrieb', 'To-Dos', ben, 0);
  card('Rechnungen einfordern', 'Allgemein', 'To-Dos', null, 5, { priority: 'niedrig' });

  const note = (content, ref, days, extra = {}) => {
    s.notes.push({
      id: id(), content, card_id: ref.card?.id ?? null, person_id: ref.person?.id ?? ref.card?.person_id ?? null,
      org_id: ref.person?.org_id ?? ref.card?.org_id ?? null, source: 'manual', private: false, author: 'demo@beispiel.de',
      created_at: ago(days), updated_at: ago(days), ...extra,
    });
  };
  note('Vertrag soweit ok, kleine Flächenanpassungen.<br>Nächster Schritt: Rückmeldung vom Anwalt abwarten.', { card: vertrag }, 3);
  note('Bedarf: ca. 40 Zugänge, Start im Januar möglich.', { card: angebot }, 1);
  note('Sucht 2–3 Zimmer, max. 50 km um Musterstadt.', { person: eva }, 8);
  // Geteilter Deal mit dem Demo-Gast (Gast-Ansicht: ?demo&gast)
  s.card_shares.push({ id: id(), card_id: rahmen.id, email: 'gast@beispiel.de', created_at: ago(2) });
  note('Entwurf liegt bei Partner Süd, Rückmeldung bis Freitag zugesagt.', { card: rahmen }, 2);
  note('Preisrahmen intern: bis 5 % Nachlass vertretbar.', { card: rahmen }, 2, { private: true });
  note('Habe mit David telefoniert, Paragraf 4 wird noch angepasst.', { card: rahmen }, 1, { author: 'gast@beispiel.de' });

  const projectId = (name) => s.projects.find((p) => p.name === name).id;
  const meeting = (title, project, days, minutes, people, extra, summary) => {
    const m = {
      id: id(), title, held_at: ago(days, 3), duration_min: minutes, project_id: projectId(project),
      summary, extra_names: extra, fireflies_id: null, created_at: ago(days), updated_at: ago(days),
    };
    s.meetings.push(m);
    people.forEach((p) => s.meeting_persons.push({ id: id(), meeting_id: m.id, person_id: p.id }));
  };
  // „Alex Demo“ ist der Demo-Nutzer (demo@beispiel.de), seine Action Items gelten als eigene
  meeting('Abstimmung Kundenportal', 'Vertrieb', 1, 25, [anna], ['Lisa Beispielfrau'],
    '<ul><li><strong>Bedarf:</strong> Musterfirma sucht einen Partner für ihr Kundenportal.</li>'
    + '<li><strong>Preise:</strong> Angebot bis Ende des Monats.</li></ul>'
    + '<h2>Action Items</h2><h3>Alex Demo</h3><ul><li>Angebot schreiben</li><li>Referenzliste schicken</li></ul>'
    + '<h3>Anna Beispiel</h3><ul><li>Nutzerzahlen der letzten Monate senden</li></ul>');
  meeting('Partnerschaft Süd', 'Kooperationen', 6, 40, [david], [],
    '<ul><li><strong>Kapazität:</strong> 12 Mitarbeitende, Ausbau im Frühjahr geplant.</li>'
    + '<li><strong>Vertrag:</strong> Entwurf geht bis Freitag raus.</li></ul>');
  meeting('Wochenrunde Vertrieb', 'Vertrieb', 3, 50, [ben], ['Max Platzhalter', 'Erika Muster'],
    '<ul><li><strong>Pipeline:</strong> Drei neue Gespräche mit Interessenten.</li><li><strong>Events:</strong> Messeplanung für November.</li></ul>');
  meeting('Besichtigung, Finanzierung', 'Objekte', 9, 15, [eva], [],
    '<ul><li><strong>Besichtigung:</strong> Samstagmittag bevorzugt.</li><li><strong>Finanzierung:</strong> Bankgespräch läuft.</li></ul>');
  meeting('Unterlagen Steuerberatung', 'Allgemein', 12, 20, [], [],
    '<ul><li><strong>Belege:</strong> Unterlagen für die Steuerberatung zusammenstellen.</li></ul>');

  const mail = (p, direction, subject, days, body, extra = {}) => {
    const m = {
      id: id(), message_id: `<demo-${seq}@beispiel.de>`, thread_id: null, mailbox: 'demo@beispiel.de', gmail_id: null,
      direction, from_email: direction === 'in' ? p.emails[0] : 'demo@beispiel.de',
      from_name: direction === 'in' ? p.name : 'Alex Demo',
      to_emails: direction === 'in' ? ['demo@beispiel.de'] : [p.emails[0]], cc_emails: [],
      subject, sent_at: ago(days, 2), body, attachments: [], created_at: ago(days), ...extra,
    };
    s.emails.push(m);
    s.email_persons.push({ id: id(), email_id: m.id, person_id: p.id });
  };
  mail(anna, 'in', 'Nutzerzahlen Oktober', 0, 'Hallo Alex,\n\nanbei wie besprochen die Nutzerzahlen der letzten Monate.\n\nViele Grüße\nAnna Beispiel',
    { attachments: ['Nutzerzahlen_2026.xlsx'] });
  mail(anna, 'out', 'Angebot Kundenportal', 1, 'Hallo Frau Beispiel,\n\ndas Angebot kommt bis Freitag.\n\nBeste Grüße\nAlex Demo\n\nAm 29.10.2026 um 10:12 schrieb Anna Beispiel:\n> Wann können wir mit dem Angebot rechnen?');
  // Termine heute und in den nächsten Tagen, Uhrzeit in Ortszeit
  const at = (days, hour, min = 0) => {
    const d = new Date();
    d.setDate(d.getDate() + days);
    d.setHours(hour, min, 0, 0);
    return d.toISOString();
  };
  const event = (title, cal, color, days, h, dur, people, extra = {}) => {
    const e = {
      id: id(), calendar_id: cal.toLowerCase() + '@demo', calendar_name: cal, calendar_color: color,
      event_id: 'demo' + seq, ical_uid: 'demo' + seq, title, start_at: at(days, h), end_at: at(days, h, dur),
      all_day: false, location: null, meet_url: null, html_link: null, organizer: null,
      attendees: people.map((p) => p.emails[0]).filter(Boolean), description: null, status: 'confirmed', ...extra,
    };
    s.events.push(e);
    people.forEach((p) => s.event_persons.push({ id: id(), event_id: e.id, person_id: p.id }));
  };
  event('Abstimmung Angebot Kundenportal', 'Vertrieb', '#9a9cff', 0, 10, 30, [anna], { meet_url: 'https://meet.google.com/abc-defg-hij' });
  event('Wochenrunde Vertrieb', 'Vertrieb', '#7fa7c9', 0, 15, 50, [ben]);
  event('Zahnarzt', 'Privat', '#e07a7a', 0, 18, 45, []);
  event('Besichtigung Musterstadt', 'Objekte', '#d98b4f', 1, 12, 60, [eva], { location: 'Musterstraße 5, Musterstadt' });
  event('Partner-Call', 'Kooperationen', '#6fb58f', 2, 9, 30, [david]);
  event('Messeplanung', 'Kooperationen', '#6fb58f', 0, 10, 60, [david]);
  event('Steuerunterlagen sortieren', 'Privat', '#e07a7a', -1, 16, 90, []);
  event('Wochenrunde Vertrieb', 'Vertrieb', '#7fa7c9', 4, 15, 50, [ben]);
  event('Messe Musterstadt', 'Kooperationen', '#6fb58f', 3, 0, 0, [], {
    all_day: true, start_at: inDays(3) + 'T00:00:00Z', end_at: inDays(5) + 'T00:00:00Z',
  });

  mail(david, 'in', 'Rückfrage Vertrag', 3, 'Moin,\n\nkurze Rückfrage zu Paragraf 4 im Vertragsentwurf. Passt Ihnen ein Telefonat am Montag?\n\nDavid Test');

  s.seq = seq;
  return s;
}
