// Keep the setup guide and the trusted clipboard action on the same scope list.
// Jira uses classic scope names within Atlassian's scoped API-token flow.
export const connectionScopes = {
  jira: [
    ['read:jira-user', 'View user profiles'],
    ['read:jira-work', 'View Jira issue data'],
  ],
  bitbucket: [
    ['read:user:bitbucket', 'User · Read'],
    ['read:repository:bitbucket', 'Repositories · Read'],
    ['write:repository:bitbucket', 'Repositories · Write'],
    ['read:pullrequest:bitbucket', 'Pull requests · Read'],
    ['write:pullrequest:bitbucket', 'Pull requests · Write'],
  ],
} as const;
