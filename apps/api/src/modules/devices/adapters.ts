/**
 * Device payload adapters. Readers from different vendors send different shapes; each adapter turns a
 * vendor payload into normalised events. Add a vendor by registering a new adapter — the ingest
 * endpoint, de-duplication and storage stay the same.
 */
import { z } from 'zod';

export interface NormalisedEvent { eventId: string; identifier: string; identifierType: 'card_uid' | 'identity_token'; direction: 'in' | 'out'; occurredAt: Date }
export interface DeviceAdapter { id: string; description: string; parse(body: unknown): NormalisedEvent[] }

const generic = z.object({
  events: z.array(z.object({
    eventId: z.string().min(1).max(100),
    cardUid: z.string().min(4).max(64).optional(),
    identityToken: z.string().min(8).max(64).optional(),
    direction: z.enum(['in', 'out']).default('in'),
    occurredAt: z.string().datetime(),
  }).refine((e) => e.cardUid || e.identityToken, 'cardUid or identityToken required')).min(1).max(500),
});

const ADAPTERS: Record<string, DeviceAdapter> = {
  'generic-json': {
    id: 'generic-json',
    description: '{ events: [{ eventId, cardUid | identityToken, direction: "in"|"out", occurredAt (ISO) }] }',
    parse: (body) => generic.parse(body).events.map((e) => ({
      eventId: e.eventId, identifier: (e.cardUid ?? e.identityToken)!.trim(), identifierType: e.cardUid ? 'card_uid' : 'identity_token',
      direction: e.direction, occurredAt: new Date(e.occurredAt),
    })),
  },
};

export const getAdapter = (id: string) => ADAPTERS[id];
export const listAdapters = () => Object.values(ADAPTERS).map(({ id, description }) => ({ id, description }));
