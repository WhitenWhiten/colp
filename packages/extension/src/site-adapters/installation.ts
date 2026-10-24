import { legacySite, type SiteDefinition } from './registry.js';
/** Retain old Bilibili storage/port names; every additional installation gets a distinct namespace. */
export const installationKey = (base: string, site: Pick<SiteDefinition, 'adapterId'>) => site.adapterId === legacySite.adapterId ? base : `${base}:${site.adapterId}`;
