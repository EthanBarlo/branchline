export function isTrustedReviewSender(event: { sender: unknown; senderFrame: unknown }, contents: { mainFrame: unknown } | null, url: string | undefined, trustedURL: string): boolean {
  return contents !== null && event.sender === contents && event.senderFrame === contents.mainFrame && url === trustedURL;
}
