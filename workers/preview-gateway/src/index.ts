import { handleRequest, type GatewayEnv } from './gateway.ts';

/**
 * `preview-gateway`: serves pull request previews of the hub on `pr-<n>-preview.the40thieves.dev`, so
 * nothing public (PR comments, CI logs, the ZAP target) names the account's workers.dev
 * subdomain. The routing and rewriting live in gateway.ts.
 */
export default {
  fetch(request: Request, env: GatewayEnv): Promise<Response> {
    return handleRequest(request, env);
  },
} satisfies ExportedHandler<GatewayEnv>;
