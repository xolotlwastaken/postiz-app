import { HttpStatus, Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { OrganizationService } from '@gitroom/nestjs-libraries/database/prisma/organizations/organization.service';
import { OAuthService } from '@gitroom/nestjs-libraries/database/prisma/oauth/oauth.service';
import { HttpForbiddenException } from '@gitroom/nestjs-libraries/services/exception.filter';
import { setSentryUserContext } from '@gitroom/nestjs-libraries/sentry/initialize.sentry';
import { PrismaService } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { createHmac } from 'node:crypto';

@Injectable()
export class PublicAuthMiddleware implements NestMiddleware {
  constructor(
    private _organizationService: OrganizationService,
    private _oauthService: OAuthService,
    private db: PrismaService,
  ) {}
  async use(req: Request, res: Response, next: NextFunction) {
    const headless = process.env.POSTIZ_HEADLESS_ENABLED === 'true';
    // SwayCue owns OAuth and exposes only publishing operations to this service.
    if (headless && !/\/public\/v1\/(?:posts(?:\/[^/]+)?|integrations(?:\/[^/]+)?|upload|upload-from-url)$/.test(req.path)) {
      res.status(404).json({ msg: 'Not found' });
      return;
    }
    const auth = (req.headers.authorization ||
      req.headers.Authorization) as string;
    if (!auth) {
      res.status(HttpStatus.UNAUTHORIZED).json({ msg: 'No API Key found' });
      return;
    }
    try {
      if (!headless && auth.startsWith('pos_')) {
        const authorization = await this._oauthService.getOrgByOAuthToken(auth);
        if (!authorization) {
          res
            .status(HttpStatus.UNAUTHORIZED)
            .json({ msg: 'Invalid OAuth token' });
          return;
        }

        const org = authorization.organization;
        if (!!process.env.STRIPE_SECRET_KEY && !org.subscription) {
          res
            .status(HttpStatus.UNAUTHORIZED)
            .json({ msg: 'No subscription found' });
          return;
        }

        // @ts-ignore
        req.org = { ...org, users: [{ users: { role: 'SUPERADMIN' } }] };
      } else {
        const org = await this._organizationService.getOrgByApiKey(auth);
        if (!org) {
          res
            .status(HttpStatus.UNAUTHORIZED)
            .json({ msg: 'Invalid API key' });
          return;
        }

        if (headless) {
          const secret = process.env.POSTIZ_HANDOFF_SECRET?.trim();
          const expected = secret && createHmac('sha256', secret)
            .update(`swaycue:publishing:key:v1:${org.id}`).digest('hex');
          const workspaces = await this.db.$queryRaw<{ id: string }[]>`
            SELECT id FROM public."Workspace" WHERE id = ${org.id} LIMIT 1
          `;
          if (!expected || auth !== expected || !workspaces.length) {
            res.status(401).json({ msg: 'Invalid publishing workspace' });
            return;
          }
        }

        if (!!process.env.STRIPE_SECRET_KEY && !org.subscription) {
          res
            .status(HttpStatus.UNAUTHORIZED)
            .json({ msg: 'No subscription found' });
          return;
        }

        // @ts-ignore
        req.org = { ...org, users: [{ users: { role: 'SUPERADMIN' } }] };
      }
    } catch (err) {
      throw new HttpForbiddenException();
    }

    setSentryUserContext({
      // @ts-ignore
      orgId: req.org.id,
      // @ts-ignore
      paymentId: req.org.paymentId,
    });
    next();
  }
}
