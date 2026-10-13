import { Body, Controller, Headers, HttpException, Post } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { PrismaService } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { ioRedis } from '@gitroom/nestjs-libraries/redis/redis.service';

// This is a service-to-service boundary. Supabase sessions and membership
// checks belong to SwayCue; browsers never receive this secret or an API key.
@Controller('/swaycue')
export class SwayCueWorkspaceController {
  constructor(private readonly db: PrismaService) {}

  @Post('/workspaces')
  async provision(
    @Body() body: { workspaceId?: unknown; nonce?: unknown; timestamp?: unknown },
    @Headers('x-swaycue-signature') signature?: string,
  ) {
    const secret = process.env.POSTIZ_HANDOFF_SECRET?.trim();
    if (!secret || !signature) throw new HttpException('Unauthorized', 401);
    if (!body || typeof body.workspaceId !== 'string' ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(body.workspaceId) ||
        typeof body.nonce !== 'string' || !/^[A-Za-z0-9_-]{24,128}$/.test(body.nonce) ||
        typeof body.timestamp !== 'number' || !Number.isSafeInteger(body.timestamp) ||
        Math.abs(Date.now() - body.timestamp) > 60_000 ||
        Object.keys(body).some((key) => !['workspaceId', 'nonce', 'timestamp'].includes(key))) {
      throw new HttpException('Invalid provisioning request', 400);
    }
    const canonical = JSON.stringify({ workspaceId: body.workspaceId, nonce: body.nonce, timestamp: body.timestamp });
    const expected = createHmac('sha256', secret).update(`swaycue:workspace:v1:${canonical}`).digest('base64url');
    if (signature.length !== expected.length ||
        !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
      throw new HttpException('Unauthorized', 401);
    }
    if (await ioRedis.set(`swaycue:workspace:nonce:${body.nonce}`, '1', 'EX', 120, 'NX') !== 'OK') {
      throw new HttpException('Provisioning request already used', 409);
    }

    // Qualified name is essential: Postiz uses the postiz schema while the
    // workspace and Supabase-backed identity live in the same DB's public schema.
    const workspaces = await this.db.$queryRaw<{ id: string; name: string }[]>`
      SELECT id, name FROM public."Workspace" WHERE id = ${body.workspaceId} LIMIT 1
    `;
    if (!workspaces.length) throw new HttpException('Workspace not found', 404);
    const apiKey = createHmac('sha256', secret)
      .update(`swaycue:publishing:key:v1:${body.workspaceId}`).digest('hex');
    const org = await this.db.organization.upsert({
      where: { id: body.workspaceId },
      create: { id: body.workspaceId, name: workspaces[0].name, apiKey },
      update: {},
    });
    if (org.deletedAt || org.apiKey !== apiKey) {
      throw new HttpException('Publishing workspace requires credential migration', 409);
    }
    return { organizationId: org.id, apiKey: org.apiKey };
  }
}
