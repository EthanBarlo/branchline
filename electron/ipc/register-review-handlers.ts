import type { ReviewRequestArguments, ReviewRequestHandler, ReviewRequestName } from '../../shared/ipc';
import type { InstallGate } from '../application/install-gate';
import { isTrustedReviewSender } from './ipc-trust';

export type ReviewHandlerRegistrar = <Name extends ReviewRequestName>(
  name: Name,
  handler: ReviewRequestHandler<Name>,
) => void;

export interface ReviewIpcEvent {
  sender: unknown;
  senderFrame: { url: string } | null;
}

interface RegistrarDependencies {
  register(channel: string, handler: (event: ReviewIpcEvent, ...args: unknown[]) => unknown): void;
  getContents(): { mainFrame: unknown } | null;
  trustedURL: string;
  closeGate: Pick<InstallGate, 'run'>;
  installGate: Pick<InstallGate, 'run'>;
}

const controlRequests = new Set<ReviewRequestName>([
  'state',
  'close-listener',
  'close-ready',
  'update-state',
  'update-check',
  'update-download',
  'update-install',
]);

/** Disposable reads, previews and caches must not hold the window open. */
const disposableCloseRequests = new Set<ReviewRequestName>([
  'git-cache',
  'git-history',
  'git-project-history',
  'git-status',
  'git-fetch',
  'git-preview',
  'integrations-state',
  'integration-diagnostics',
  'integration-log-open',
  'connection-copy-scopes',
  'connection-test',
  'integrations-discover',
  'pullrequests-list',
  'pullrequests-state',
  'jira-issue',
  'jira-ticket-suggestions',
  'jira-ticket-link',
  'jira-browser-resize',
  'jira-browser-focus',
  'feedback-preview',
  'merge-preview',
  'closed-review-check',
  'integration-open',
  'jira-open',
  'choose-repo',
  'inspect',
  'refresh',
  'copy',
]);

/** Trust every request; protect writes on close and all work during update installation. */
export function createReviewHandlerRegistrar(dependencies: RegistrarDependencies): ReviewHandlerRegistrar {
  return <Name extends ReviewRequestName>(name: Name, handler: ReviewRequestHandler<Name>) => {
    dependencies.register(`review:${name}`, (event, ...args) => {
      if (
        !isTrustedReviewSender(
          event,
          dependencies.getContents(),
          event.senderFrame?.url,
          dependencies.trustedURL,
        )
      ) {
        throw new Error('This request did not come from the review window.');
      }
      const invoke = () => handler(...(args as ReviewRequestArguments<Name>));
      if (controlRequests.has(name)) return invoke();
      const installProtected = () => dependencies.installGate.run(name, invoke);
      return disposableCloseRequests.has(name)
        ? installProtected()
        : dependencies.closeGate.run(name, installProtected);
    });
  };
}
