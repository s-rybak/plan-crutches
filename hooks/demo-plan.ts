// Generated from fixtures/demo-plan.md. Edit the fixture and regenerate.
export const DEMO_PLAN = `# Session refresh for the auth module

## Context

Users are logged out when the access token expires because nothing refreshes the session. The task (AUTH-42) asks for a silent refresh and for the removal of the legacy token store.

## Approach

1. Add a \`session.ts\` module with a refresh function and a small in-memory cache.
2. Teach \`user.ts\` to call the refresh when a token is close to expiry.
3. Expose a \`/auth/refresh\` route.
4. Delete the legacy token store.
5. Document the flow.

## Risks

- The refresh endpoint must not be callable without the refresh cookie.
- The cache is per process; a multi-instance deploy needs Redis later.

\`\`\`plan-crutches
{
  "title": "Session refresh for the auth module",
  "summary": "Add a silent session refresh so users stay signed in.\\n\\n- New \`src/auth/session.ts\` holds \`refreshSession\` and a small cache.\\n- \`src/auth/user.ts\` calls the refresh when a token is within 60 seconds of expiry.\\n- \`src/api/routes.ts\` gains \`POST /auth/refresh\`, guarded by the refresh cookie.\\n- The legacy \`src/legacy/tokens.ts\` store goes away.\\n- \`docs/auth.md\` explains the flow.\\n\\nRisks: the cache is per process; a multi-instance deploy needs Redis later.",
  "task": {
    "source": "jira",
    "key": "AUTH-42",
    "title": "Users get logged out after 15 minutes",
    "text": "As a signed-in user I want to stay signed in while I use the app.\\n\\nAcceptance criteria:\\n- The access token is refreshed silently before it expires.\\n- A failed refresh sends the user to the login page with a message.\\n- The old token store in src/legacy is removed."
  },
  "files": [
    {
      "path": "src/auth/session.ts",
      "status": "new",
      "description": "Session refresh logic and an in-memory cache of refresh promises, so parallel callers share one request.",
      "symbols": [
        {
          "name": "Session",
          "kind": "type",
          "signature": "export type Session = { userId: string; accessToken: string; expiresAt: number }",
          "description": "The session as the client keeps it."
        },
        {
          "name": "refreshSession",
          "kind": "function",
          "signature": "export async function refreshSession(userId: string): Promise<Session> {",
          "description": "Calls the refresh endpoint once per user at a time and returns the new session.",
          "anchor": "after Session"
        },
        {
          "name": "isExpiringSoon",
          "kind": "function",
          "signature": "export function isExpiringSoon(session: Session, now: number, marginMs = 60_000): boolean {",
          "description": "True when the access token expires within the margin.",
          "anchor": "end of file"
        }
      ]
    },
    {
      "path": "src/auth/user.ts",
      "status": "modified",
      "description": "Refresh the session before returning the current user when the token is close to expiry; drop the display-name helper.",
      "symbols": [
        {
          "name": "getCurrentUser",
          "kind": "function",
          "change": "modified",
          "signature": "export async function getCurrentUser(): Promise<User | null> {",
          "description": "Returns the current user, refreshing the session first when isExpiringSoon says so."
        },
        {
          "name": "displayNameOf",
          "kind": "function",
          "change": "deleted",
          "signature": "export function displayNameOf(user: User): string {",
          "description": "Moves to the presentation layer; nothing in auth uses it."
        }
      ]
    },
    {
      "path": "src/api/routes.ts",
      "status": "modified",
      "description": "Add the refresh route.",
      "symbols": [
        {
          "name": "refreshRoute",
          "kind": "const",
          "signature": "export const refreshRoute = route.post('/auth/refresh', requireRefreshCookie, handleRefresh)",
          "description": "POST /auth/refresh, allowed only with the refresh cookie.",
          "anchor": "after loginRoute"
        }
      ]
    },
    {
      "path": "src/legacy/tokens.ts",
      "status": "deleted",
      "description": "The legacy token store is replaced by session.ts.",
      "symbols": []
    },
    {
      "path": "docs/auth.md",
      "status": "new",
      "description": "Explains the refresh flow and the cookie requirement.",
      "symbols": []
    }
  ]
}
\`\`\`
`
