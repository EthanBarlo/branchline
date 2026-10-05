import { useParams } from '@tanstack/react-router';
import { extractJiraTicketKey } from '../../../shared/jira';
import { useWorkspace } from '../workspace/WorkspaceProvider';
import { SettingsView } from './SettingsView';

export function SettingsPage() {
  const { section } = useParams({ from: '/_workspace/settings/$section' });
  const { settings, setSettings, loadIntegrations, reviews, navigation, lifecycle } = useWorkspace();
  const review = reviews.find((item) => item.id === navigation.selectedReviewId);
  return (
    <SettingsView
      section={section}
      backLabel={navigation.workspaceArea === 'git' ? 'Back to Git' : 'Back to review'}
      onSectionChange={(next) => void navigation.openSettings(next, navigation.showLegacyLinks)}
      showLegacyLinks={navigation.showLegacyLinks}
      settings={settings}
      ticket={extractJiraTicketKey(review?.featureBranch || '')}
      onSaved={setSettings}
      onConnectionsChanged={loadIntegrations}
      onClose={() => void navigation.closeSettings()}
      updateState={lifecycle.updateState}
      updateBridgeError={lifecycle.updateBridgeError}
      onUpdateAction={(action) => void lifecycle.updateAction(action)}
    />
  );
}
