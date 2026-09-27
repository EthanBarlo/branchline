import { join } from 'node:path';
import type { Review } from '../../shared/types';
import { buildSnapshot, inspectRepo } from '../git/repository';
import { PointerService } from '../git/pointer-service';
import { ConnectionManager, type SecureStorage } from '../integrations/connection-manager';
import { IntegrationService } from '../integrations/integration-service';
import { IntegrationStore } from '../integrations/integration-store';
import { ProjectService } from '../projects/project-service';
import { ReviewService } from '../reviews/review-service';
import { ReviewStore } from '../reviews/review-store';

/** Constructs the desktop domain services after their persisted state is loaded. */
export async function createServices(dataDirectory: string, secureStorage: SecureStorage) {
  const store = new ReviewStore(join(dataDirectory, 'reviews.json'));
  await store.load();
  const projects = new ProjectService(store);
  let integrations: IntegrationService;
  const reviews = new ReviewService(store, inspectRepo, (config) =>
    config.remote ? integrations.buildSnapshot(config as Review) : buildSnapshot(config),
  );
  const integrationStore = new IntegrationStore(join(dataDirectory, 'integrations.json'));
  const connections = new ConnectionManager(join(dataDirectory, 'credentials.json'), secureStorage);
  await integrationStore.load();
  await connections.load();
  integrations = new IntegrationService(
    store,
    reviews,
    integrationStore,
    connections,
    new PointerService(join(dataDirectory, 'pointer-workspaces')),
  );
  await integrations.removeCompletedReviews();
  return { store, projects, integrations, integrationStore };
}
