// grants.ts — kortet för appens webbläsarbehörigheter (CONTRACT §13). Tillåt sparas med setGrants
// (bus.ts) och sänder grants:changed så att världen bygger om iframen. Neka sparas här, per webbläsare,
// så att frågan inte kommer tillbaka.
import type { AppPermission } from '../../../shared/protocol.ts';
import { bus, grantsFor, setGrants } from '../bus.ts';
import { button, el } from './asks.ts';
import { pendingPermissions, permissionSentence } from './model.ts';

const DENIED_KEY = 'wb:hud:denied';

function readDenied(): Record<string, AppPermission[]> {
  try {
    const v = JSON.parse(localStorage.getItem(DENIED_KEY) ?? '{}') as unknown;
    return v && typeof v === 'object' ? (v as Record<string, AppPermission[]>) : {};
  } catch {
    return {};
  }
}

export function deniedFor(appId: string): AppPermission[] {
  const all = readDenied();
  return Array.isArray(all[appId]) ? all[appId] : [];
}

function addDenied(appId: string, perms: AppPermission[]): void {
  try {
    const all = readDenied();
    all[appId] = [...new Set([...(Array.isArray(all[appId]) ? all[appId] : []), ...perms])];
    localStorage.setItem(DENIED_KEY, JSON.stringify(all));
  } catch {
    /* lagring otillgänglig: frågan kan komma tillbaka */
  }
}

/** Behörigheter appen vill ha som användaren inte tagit ställning till. */
export function pendingFor(appId: string, wanted: readonly AppPermission[]): AppPermission[] {
  return pendingPermissions(wanted, grantsFor(appId), deniedFor(appId));
}

export function allow(appId: string, perms: AppPermission[]): void {
  setGrants(appId, [...new Set([...grantsFor(appId), ...perms])]);
  bus.emit('grants:changed', { appId });
}

export function deny(appId: string, perms: AppPermission[]): void {
  addDenied(appId, perms);
}

/** Kortet: "<namn> vill använda mikrofonen" med Tillåt/Neka. */
export function grantsCard(name: string, perms: AppPermission[], onAllow: () => void, onDeny: () => void): HTMLElement {
  const sentence = permissionSentence(name, perms);
  const card = el('div', 'wbh-card');
  card.setAttribute('role', 'group');
  card.setAttribute('aria-label', sentence);
  card.append(el('div', 'wbh-card-title', sentence));
  const row = el('div', 'wbh-actions');
  const yes = button('Tillåt', 'wbh-btn is-primary');
  const no = button('Neka');
  yes.addEventListener('click', onAllow);
  no.addEventListener('click', onDeny);
  row.append(yes, no);
  card.append(row);
  return card;
}
