import { CanActivate, Injectable } from '@nestjs/common';

// Extension point for external OIDC authentication and provider authorization.
@Injectable()
export class ProviderAuthGuard implements CanActivate {
  canActivate(): boolean { return true; }
}
