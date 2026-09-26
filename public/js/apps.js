// Applications du logiciel (menu d'accueil façon Odoo) : icône, couleurs, sous-menus et droit nécessaire.
import { store } from './api.js';

export const APPS = [
  { key: 'dashboard', name: 'Tableau de bord', icon: 'layout-dashboard', c: ['#7c3aed', '#f472b6'], to: '/', routes: ['dashboard'] },
  { key: 'copilot', name: 'Nova', icon: 'sparkles', c: ['#6366f1', '#22d3ee'], to: '/copilot', routes: ['copilot'], perm: 'ia' },
  { key: 'office', name: 'Bureau IA', icon: 'brain', c: ['#0ea5e9', '#a78bfa'], to: '/office', routes: ['office'], perm: 'ia' },
  { key: 'mail', name: 'Discussion', icon: 'mail', c: ['#f97316', '#fbbf24'], to: '/mail', routes: ['mail'], perm: 'emails' },
  { key: 'activities', name: 'To-do', icon: 'list-todo', c: ['#0f766e', '#5eead4'], to: '/activities', routes: ['activities'] },
  { key: 'crm', name: 'CRM', icon: 'handshake', c: ['#0d9488', '#f472b6'], to: '/crm', routes: ['crm'], perm: 'crm',
    menus: [{ label: 'Pipeline', to: '/crm' }, { label: 'Liste', to: '/crm?view=list' }, { label: 'Perdues', to: '/crm?view=lost' }, { label: 'Analyse', to: '/crm?view=stats' }] },
  { key: 'website', name: 'Site web', icon: 'globe', c: ['#0284c7', '#34d399'], to: '/website', routes: ['website'], perm: 'site' },
  { key: 'social', name: 'Marketing social', icon: 'megaphone', c: ['#db2777', '#fbbf24'], to: '/social', routes: ['social'], perm: 'social',
    menus: [{ label: 'Publications', to: '/social' }, { label: 'Calendrier', to: '/social?view=calendar' }, { label: 'Comptes', to: '/social?view=accounts' }] },
  { key: 'workshop', name: 'Atelier', icon: 'wrench', c: ['#dc2626', '#fb923c'], to: '/workshop', routes: ['workshop'], perm: 'atelier',
    menus: [{ label: 'Tableau atelier', to: '/workshop' }, { label: 'Ordres de réparation', to: '/documents/order' }, { label: 'Planning', to: '/planning' }, { label: 'Nouvel OR', to: '/new/order' }] },
  { key: 'planning', name: 'Rendez-vous', icon: 'calendar-days', c: ['#9333ea', '#22d3ee'], to: '/planning', routes: ['planning'], perm: 'atelier' },
  { key: 'attendance', name: 'Présences', icon: 'user-check', c: ['#ea580c', '#fbbf24'], to: '/attendance', routes: ['attendance'],
    menus: [{ label: 'Mon pointage', to: '/attendance' }, { label: 'Équipe', to: '/attendance?tab=board', perm: 'presences' }, { label: 'Rapports', to: '/attendance?tab=report', perm: 'presences' }, { label: 'Kiosque', href: '/kiosk.html' }] },
  { key: 'timesheets', name: 'Feuilles de temps', icon: 'timer', c: ['#1d4ed8', '#f472b6'], to: '/timesheets', routes: ['timesheets'], perm: 'presences' },
  { key: 'sales', name: 'Ventes', icon: 'chart-column', c: ['#c2410c', '#fb7185'], to: '/documents/quote', routes: ['documents:quote', 'documents:invoice', 'documents:credit_note', 'document'], perm: 'ventes',
    menus: [{ label: 'Devis', to: '/documents/quote' }, { label: 'Factures', to: '/documents/invoice' }, { label: 'Avoirs', to: '/documents/credit_note' }, { label: 'Clients', to: '/customers', perm: 'contacts' }] },
  { key: 'contacts', name: 'Contacts', icon: 'contact', c: ['#0d9488', '#f472b6'], to: '/customers', routes: ['customers', 'customer', 'suppliers'], perm: 'contacts',
    menus: [{ label: 'Clients', to: '/customers' }, { label: 'Fournisseurs', to: '/suppliers' }] },
  { key: 'vehicles', name: 'Parc automobile', icon: 'car', c: ['#7e22ce', '#2dd4bf'], to: '/vehicles', routes: ['vehicles', 'vehicle'], perm: 'vehicules' },
  { key: 'stock', name: 'Inventaire', icon: 'package', c: ['#ea580c', '#a855f7'], to: '/stock', routes: ['stock', 'product'], perm: 'inventaire',
    menus: [{ label: 'Articles & stock', to: '/stock' }, { label: 'Achats', to: '/purchases', perm: 'achats' }] },
  { key: 'purchases', name: 'Achats', icon: 'shopping-cart', c: ['#0f766e', '#a78bfa'], to: '/purchases', routes: ['purchases', 'purchase'], perm: 'achats',
    menus: [{ label: 'Achats & factures fournisseurs', to: '/purchases' }, { label: 'Fournisseurs', to: '/suppliers', perm: 'contacts' }, { label: 'Articles', to: '/stock', perm: 'inventaire' }] },
  { key: 'bank', name: 'Banque', icon: 'landmark', c: ['#0369a1', '#34d399'], to: '/bank', routes: ['bank'], perm: 'banque' },
  { key: 'accounting', name: 'Comptabilité', icon: 'book-open', c: ['#be185d', '#34d399'], to: '/accounting', routes: ['accounting'], perm: 'comptabilite' },
  { key: 'users', name: 'Employés & accès', icon: 'shield-check', c: ['#f59e0b', '#8b5cf6'], to: '/settings?tab=users', routes: ['settings:users'], admin: true },
  { key: 'settings', name: 'Paramètres', icon: 'settings', c: ['#b45309', '#8b5cf6'], to: '/settings', routes: ['settings'], admin: true,
    menus: [{ label: 'Société', to: '/settings?tab=company' }, { label: 'Configuration', to: '/settings?tab=config' }, { label: 'Utilisateurs & accès', to: '/settings?tab=users' }, { label: 'Mise en page', to: '/settings?tab=layout' }] },
  { key: 'kiosk', name: 'Kiosque pointage', icon: 'tablet', c: ['#16a34a', '#22d3ee'], href: '/kiosk.html' },
];

const RANK = { none: 0, read: 1, user: 2, manager: 3 };
/** L'utilisateur connecté a-t-il ce droit ? (le gérant a tout) */
export function can(app, level = 'read') {
  const u = store.user;
  if (!u) return false;
  if (u.role === 'admin') return true;
  if (!app) return true;
  return (RANK[u.perms?.[app]] || 0) >= RANK[level];
}
export const visibleApps = () => APPS.filter((a) => (a.admin ? store.user?.role === 'admin' : can(a.perm)));

/** Application correspondant à la page affichée (pour la barre du haut). */
export function currentApp(route) {
  const key = route.name === 'documents' ? `documents:${route.params.type}` : route.name === 'settings' && route.query.tab === 'users' ? 'settings:users' : route.name;
  if (route.name === 'documents' && route.params.type === 'order') return APPS.find((a) => a.key === 'workshop');
  if (route.name === 'document') {
    const t = route.params.type || route.query.type;
    if (t === 'order') return APPS.find((a) => a.key === 'workshop');
  }
  return APPS.find((a) => a.routes?.includes(key)) || APPS.find((a) => a.routes?.includes(route.name)) || null;
}
