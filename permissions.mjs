/**
 * Permission keys shared by the role/permission system.
 *
 * Pages:
 *   dashboard, tasks.view, templates.view, schemas
 * Task actions (CRUD):
 *   tasks.create, tasks.rerun, tasks.delete
 * Template actions (CRUD):
 *   templates.create, templates.edit, templates.delete
 *
 * Settings is intentionally NOT a permission: it is admin-only (role 1).
 */

export const PERMISSION_KEYS = [
  'dashboard',
  'tasks.view',
  'tasks.create',
  'tasks.rerun',
  'tasks.delete',
  'templates.view',
  'templates.create',
  'templates.edit',
  'templates.delete',
  'schemas',
];

/** Full access (admin, or a role with everything checked). */
export function fullPermissions() {
  return Object.fromEntries(PERMISSION_KEYS.map((k) => [k, true]));
}

/** Default for a newly created role: pages + view on, mutations off. */
export function defaultPermissions() {
  const p = {};
  for (const k of PERMISSION_KEYS) {
    p[k] = k === 'dashboard' || k === 'schemas' || k.endsWith('.view');
  }
  return p;
}

export function permissionLabel(key) {
  const labels = {
    dashboard: 'Dashboard',
    'tasks.view': 'Tasks — view',
    'tasks.create': 'Tasks — create (extract)',
    'tasks.rerun': 'Tasks — re-run',
    'tasks.delete': 'Tasks — delete',
    'templates.view': 'Templates — view',
    'templates.create': 'Templates — create',
    'templates.edit': 'Templates — edit',
    'templates.delete': 'Templates — delete',
    schemas: 'Schema Generator',
  };
  return labels[key] || key;
}
