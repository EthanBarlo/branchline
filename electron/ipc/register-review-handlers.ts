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

/** All review requests pass through the same sender check and shutdown gates. */
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
      return controlRequests.has(name)
        ? invoke()
        : dependencies.closeGate.run(name, () => dependencies.installGate.run(name, invoke));
    });
  };
}
