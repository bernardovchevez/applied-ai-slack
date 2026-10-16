/** In-flight **Retry** clicks keyed by Slack message (`channel:ts`). */
const activeRetries = new Set<string>();

export function retryGuardKey(channelId: string, messageTs: string): string {
  return `${channelId}:${messageTs}`;
}

/** Returns false if this message already has a retry running. */
export function tryAcquireRetry(key: string): boolean {
  if (activeRetries.has(key)) return false;
  activeRetries.add(key);
  return true;
}

export function releaseRetry(key: string): void {
  activeRetries.delete(key);
}
