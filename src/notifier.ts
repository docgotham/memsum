import fs from "node:fs/promises";
import path from "node:path";
import type { DmsumConfig, InteractionCommit, NotificationRecord, Participant, WikiUpdateCommit } from "./types.js";

export class DryRunNotifier {
  constructor(private readonly config: DmsumConfig) {}

  async notifyInteraction(commit: InteractionCommit, notificationText?: string): Promise<NotificationRecord[]> {
    if (!notificationText?.trim()) return [];
    const directedRecipients = new Set(commit.addressedParticipants);
    const recipients = this.config.participants.filter(
      (participant) => participant.notifications !== "off" && directedRecipients.has(participant.id)
    );
    return this.writeRecords(recipients.map((recipient) => this.createInteractionRecord(commit, recipient, notificationText)));
  }

  async notifyWikiUpdate(commit: WikiUpdateCommit, notificationText?: string): Promise<NotificationRecord[]> {
    const directedRecipients = new Set(commit.attention);
    const recipients = this.config.participants.filter(
      (participant) => participant.notifications !== "off" && directedRecipients.has(participant.id)
    );
    return this.writeRecords(recipients.map((recipient) => this.createWikiUpdateRecord(commit, recipient, notificationText)));
  }

  private async writeRecords(records: NotificationRecord[]): Promise<NotificationRecord[]> {
    if (records.length === 0) return [];

    await fs.mkdir(this.config.stateDir, { recursive: true });
    const logPath = path.join(this.config.stateDir, "notifications.jsonl");
    const lines = records.map((record) => JSON.stringify(record)).join("\n");
    await fs.appendFile(logPath, `${lines}\n`, "utf8");
    return records;
  }

  private createInteractionRecord(
    commit: InteractionCommit,
    recipient: Participant,
    notificationText: string | undefined
  ): NotificationRecord {
    return {
      type: "dry_run_sms",
      sourceKind: "interaction",
      sourceId: commit.interactionId,
      timestamp: commit.timestamp,
      relationshipId: commit.relationshipId,
      participantId: commit.participant.id,
      participantName: commit.participant.displayName,
      agent: commit.agent,
      recipientId: recipient.id,
      recipientName: recipient.displayName,
      recipientPhone: recipient.phone,
      body: notificationText?.trim() || `🥟 ${commit.participant.displayName} sent you a Mem·Sum interaction.`
    };
  }

  private createWikiUpdateRecord(
    commit: WikiUpdateCommit,
    recipient: Participant,
    notificationText: string | undefined
  ): NotificationRecord {
    return {
      type: "dry_run_sms",
      sourceKind: "wiki_update",
      sourceId: commit.updateId,
      timestamp: commit.timestamp,
      relationshipId: commit.relationshipId,
      participantId: commit.participant.id,
      participantName: commit.participant.displayName,
      agent: commit.agent,
      recipientId: recipient.id,
      recipientName: recipient.displayName,
      recipientPhone: recipient.phone,
      body: notificationText?.trim() || wikiUpdateNotificationBody(commit, recipient)
    };
  }
}

function wikiUpdateNotificationBody(commit: WikiUpdateCommit, recipient: Participant): string {
  const primaryWikiPage = commit.wikiTitles[0] ?? "Mem·Sum";
  if (commit.attention.includes(recipient.id)) {
    return `🥟 ${commit.participant.displayName} updated ${primaryWikiPage} for you.`;
  }
  return `🥟 ${commit.participant.displayName} updated ${primaryWikiPage}.`;
}
