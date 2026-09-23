// Accès à l'API + formatage + notifications
import { reactive } from 'vue';

export const store = reactive({ user: null, company: '', ai: false, toasts: [], settings: null });

export async function api(method, url, body) {
  const res = await fetch('/api' + url, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'Content-Type': typeof body === 'string' ? 'text/plain' : 'application/json' },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !url.startsWith('/auth')) { store.user = null; }
  if (!res.ok) throw new Error(data.error || `Erreur ${res.status}`);
  return data;
}
export const GET = (u) => api('GET', u);
export const POST = (u, b = {}) => api('POST', u, b);
export const PUT = (u, b) => api('PUT', u, b);
export const DEL = (u) => api('DELETE', u);

export function toast(msg, type = 'ok') {
  const t = { id: Math.random(), msg, type };
  store.toasts.push(t);
  setTimeout(() => store.toasts.splice(store.toasts.indexOf(t), 1), type === 'error' ? 6000 : 3000);
}
// Exécute une action et affiche l'erreur éventuelle
export async function act(fn, okMsg) {
  try { const r = await fn(); if (okMsg) toast(okMsg); return r; } catch (e) { toast(e.message, 'error'); throw e; }
}

const eur = new Intl.NumberFormat('fr-LU', { style: 'currency', currency: 'EUR' });
export const money = (v) => eur.format(Number(v) || 0);
export const num = (v, d = 2) => (Number(v) || 0).toLocaleString('fr-LU', { maximumFractionDigits: d });
export const date = (v) => (v ? new Date(v.length === 10 ? v + 'T12:00:00' : v).toLocaleDateString('fr-LU') : '');
export const datetime = (v) => (v ? new Date(v).toLocaleString('fr-LU', { dateStyle: 'short', timeStyle: 'short' }) : '');
export const time = (v) => (v ? new Date(v).toLocaleTimeString('fr-LU', { hour: '2-digit', minute: '2-digit' }) : '');
export const hours = (h) => { h = Number(h) || 0; const m = Math.round(h * 60); return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`; };
export const today = () => { const d = new Date(); return new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
export const addDays = (s, n) => { const d = new Date(s + 'T12:00:00'); d.setDate(d.getDate() + n); return new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };

export const DOC_TYPES = { quote: 'Devis', order: 'Ordre de réparation', invoice: 'Facture', credit_note: 'Note de crédit' };
export const DOC_TYPES_SHORT = { quote: 'Devis', order: 'OR', invoice: 'Facture', credit_note: 'Avoir' };
export const STATUS = {
  draft: ['Brouillon', 'gray'], sent: ['Envoyé', 'blue'], accepted: ['Accepté', 'green'], refused: ['Refusé', 'red'],
  open: ['À faire', 'gray'], in_progress: ['En cours', 'blue'], waiting_parts: ['Attente pièces', 'orange'], done: ['Terminé', 'green'],
  invoiced: ['Facturé', 'purple'], cancelled: ['Annulé', 'red'], posted: ['À payer', 'orange'], partial: ['Partiel', 'yellow'], paid: ['Payée', 'green'],
  ordered: ['Commandé', 'blue'], received: ['Réceptionné', 'teal'], billed: ['Facturé', 'orange'],
  planned: ['Prévu', 'blue'], arrived: ['Arrivé', 'teal'],
  unmatched: ['À rapprocher', 'orange'], matched: ['Rapproché', 'green'], ignored: ['Ignoré', 'gray'],
};
export const TAX_RATES = [17, 14, 8, 3, 0];
