// Zugang zur Supabase-Datenbank (Project Settings → API).
// Beide Werte sind öffentlich und dürfen hier stehen. Den geheimen
// service_role/secret key NIE hier eintragen.
// Leer lassen = Demo-Modus mit Beispieldaten nur in diesem Browser.
export const SUPABASE_URL = 'https://erdrvhhhyqxoqccrcmub.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_Nym-BoWpI8A62GVcgnW5rw_hZr44vTq';

export const APP_NAME = 'CRM';

// Öffentlicher Schlüssel für die Erinnerungen per Push-Mitteilung (tools/push_schluessel_anlegen.py).
// Der private Teil liegt nur im Supabase-Vault.
export const PUSH_PUBLIC_KEY = 'BAFuC0wYodNqnkOMu12tsko3KI3PD44ytb08qXnhyV_ZYrVudmn4woJYucs2vfGaAvUwGs4DBVIR11ufTruQiQs';
