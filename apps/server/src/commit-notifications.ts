import type { ConfirmationGrant } from "./confirmation.ts";

export interface CommitNotification {
  roomId: string;
  revision: number;
  storedRevisions: number[];
  /** Nonces to hand to their owner's page sockets — realtime channel only. */
  confirmations: Array<ConfirmationGrant & { participantId: string }>;
}

type CommitListener = (notification: CommitNotification) => void;
const listeners: CommitListener[] = [];

export function onCommit(listener: CommitListener): void {
  listeners.push(listener);
}

/** X7: synchronous post-commit publication preserves the order in which
 * independently committed revisions enter the per-room delivery queue. */
export function notifyCommit(notification: CommitNotification): void {
  for (const listener of listeners) {
    try {
      listener(notification);
    } catch (error) {
      console.error("commit listener failed:", error);
    }
  }
}
