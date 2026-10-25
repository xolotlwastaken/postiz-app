import { createHmac } from 'node:crypto';

type PublishIdentity = { workspaceId: string; postId: string };
type PolicyFetch = (url: string, init: RequestInit) => Promise<Response>;

/** A denial is terminal: an old scheduled post must never publish after a later upgrade. */
export async function authorizeManagedPublish(identity: PublishIdentity, request: PolicyFetch = fetch) {
  const origin = process.env.SWAYCUE_APP_URL?.trim();
  const secret = process.env.POSTIZ_HANDOFF_SECRET?.trim();
  if (!origin || !secret) throw new Error('Publishing authorization unavailable');
  let url: URL;
  try {
    url = new URL('/api/internal/publishing/authorize', origin);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error();
  } catch { throw new Error('Publishing authorization unavailable'); }
  const body = { workspaceId: identity.workspaceId, postId: identity.postId, timestamp: Date.now() };
  const signature = createHmac('sha256', secret).update(`swaycue:publish:v1:${JSON.stringify(body)}`).digest('base64url');
  let response: Response;
  try {
    response = await request(url.toString(), {
      method: 'POST', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(10_000),
      headers: { 'Content-Type': 'application/json', 'X-SwayCue-Signature': signature }, body: JSON.stringify(body),
    });
  } catch { throw new Error('Publishing authorization unavailable'); }
  if (!response.ok) throw new Error('Publishing authorization denied');
  let result: { authorized?: boolean; workspaceId?: string; postId?: string };
  try { result = await response.json(); } catch { throw new Error('Publishing authorization denied'); }
  if (result.authorized !== true || result.workspaceId !== identity.workspaceId || result.postId !== identity.postId) throw new Error('Publishing authorization denied');
}

export type DispatchDatabase = {
  integration: { findFirst: (args: { where: { id: string; organizationId: string; disabled: boolean; deletedAt: null }; select: { id: true } }) => Promise<{ id: string } | null> };
  post: { findMany: (args: { where: { id: { in: string[] }; organizationId: string; integrationId: string; deletedAt: null }; select: { id: true } }) => Promise<{ id: string }[]> };
  $queryRaw: <T>(strings: TemplateStringsArray, ...values: unknown[]) => Promise<T>;
};

/** Resolve live ownership before every activity that can publish or finalize a post. */
export async function authorizePublishingDispatch(identity: { workspaceId: string; integrationId: string; postIds: string[] }, db: DispatchDatabase, request?: PolicyFetch) {
  const { workspaceId, integrationId, postIds } = identity;
  const integration = await db.integration.findFirst({ where: { id: integrationId, organizationId: workspaceId, disabled: false, deletedAt: null }, select: { id: true } });
  if (!integration) throw new Error('Publishing integration is unavailable');
  if (!postIds.length) throw new Error('Publishing post is unavailable');
  const records = await db.post.findMany({ where: { id: { in: postIds }, organizationId: workspaceId, integrationId, deletedAt: null }, select: { id: true } });
  if (new Set(postIds).size !== records.length) throw new Error('Publishing post ownership does not match');
  const tables = await db.$queryRaw<{ present: boolean }[]>`SELECT to_regclass('public."Workspace"') IS NOT NULL AS present`;
  const headless = process.env.POSTIZ_HEADLESS_ENABLED === 'true';
  if (!tables[0]?.present) {
    if (headless) throw new Error('Publishing workspace is unavailable');
    return;
  }
  const managed = await db.$queryRaw<{ id: string }[]>`SELECT id FROM public."Workspace" WHERE id = ${workspaceId} LIMIT 1`;
  if (!managed.length) {
    if (headless) throw new Error('Publishing workspace is unavailable');
    return;
  }
  await authorizeManagedPublish({ workspaceId, postId: postIds[0] }, request);
}

/** Child repeat IDs contain arbitrary suffixes; only Temporal's persisted postId metadata identifies the post. */
export async function resolvePublishingPostId(
  execution: { workflowId: string; runId: string },
  describe: (workflowId: string, runId: string) => Promise<{ postId: unknown }>
) {
  const metadata = await describe(execution.workflowId, execution.runId);
  if (typeof metadata.postId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(metadata.postId)) throw new Error('Publishing workflow post identity is unavailable');
  return metadata.postId;
}
