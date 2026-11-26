import { and, eq, inArray } from 'drizzle-orm';
import type { DbOrTx } from '../../db/client.js';
import { notifications, notificationDeliveryLogs, notificationPreferences, institutionSettings } from '../../db/schema/index.js';

export type Channel = 'in_app' | 'email' | 'sms' | 'whatsapp' | 'push';

/**
 * Provider adapter contract. A real provider returns the provider message id; delivery status is
 * updated later from provider callbacks. Acceptance by an API is NOT treated as delivery.
 */
export interface ChannelProvider { name: string; send(to: { userId: string }, msg: { title: string; body: string }): Promise<{ providerMessageId: string }> }
const providers: Partial<Record<Channel, ChannelProvider>> = {};
export function registerProvider(ch: Channel, p: ChannelProvider) { providers[ch] = p; }

export interface NotifyInput {
  institutionId: string;
  recipientUserIds: string[];
  eventKey: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

/** Writes in-app notifications and a delivery log per external channel enabled for the institution. */
export async function notify(tx: DbOrTx, n: NotifyInput) {
  const recipients = [...new Set(n.recipientUserIds)];
  if (!recipients.length) return [];
  const [settings] = await tx.select({ ns: institutionSettings.notificationSettings }).from(institutionSettings).where(eq(institutionSettings.institutionId, n.institutionId));
  const channels = ((settings?.ns as { channels?: Channel[] })?.channels ?? []).filter((c) => c !== 'in_app');
  const optOuts = await tx.select().from(notificationPreferences).where(and(eq(notificationPreferences.institutionId, n.institutionId), inArray(notificationPreferences.userId, recipients), eq(notificationPreferences.eventKey, n.eventKey), eq(notificationPreferences.enabled, false)));
  const optedOut = (u: string, c: Channel) => optOuts.some((o) => o.userId === u && o.channel === c);

  const rows = await tx.insert(notifications).values(recipients.filter((u) => !optedOut(u, 'in_app')).map((u) => ({
    institutionId: n.institutionId, recipientUserId: u, eventKey: n.eventKey, title: n.title, body: n.body, data: n.data ?? null,
  }))).returning();

  const logs = [];
  for (const row of rows) {
    logs.push({ institutionId: n.institutionId, notificationId: row.id, channel: 'in_app' as const, status: 'delivered' as const, provider: 'in_app', attempts: 1 });
    for (const ch of channels) {
      if (optedOut(row.recipientUserId, ch)) continue;
      logs.push({ institutionId: n.institutionId, notificationId: row.id, channel: ch, status: providers[ch] ? 'queued' as const : 'skipped' as const, provider: providers[ch]?.name ?? null, error: providers[ch] ? null : 'No provider configured for this channel', attempts: 0 });
    }
  }
  if (logs.length) await tx.insert(notificationDeliveryLogs).values(logs);
  return rows;
}
