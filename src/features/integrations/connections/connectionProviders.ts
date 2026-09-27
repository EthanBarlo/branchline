import { connectionScopes } from '../../../../shared/connection-scopes';

export const TOKEN_SETTINGS_URL = 'https://id.atlassian.com/manage-profile/security/api-tokens';
export const connectionProviders = {
  jira: {
    name: 'Jira',
    description: 'Keep the ticket title and description beside your review.',
    scopes: connectionScopes.jira,
    docs: 'https://support.atlassian.com/atlassian-account/docs/manage-api-tokens-for-your-atlassian-account/',
  },
  bitbucket: {
    name: 'Bitbucket',
    description: 'Review branches across repositories, create missing PRs, publish feedback and merge.',
    scopes: connectionScopes.bitbucket,
    docs: 'https://support.atlassian.com/bitbucket-cloud/docs/create-an-api-token/',
  },
} as const;
