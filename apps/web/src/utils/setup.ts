import type { CloudflareSettings, Overview } from '../types';

export function setupProgress(
  overview: Overview,
  cloudflare: CloudflareSettings,
  githubConnected: boolean,
) {
  const server = overview.system?.workerOnline === true;
  const connection = cloudflare.connected && Boolean(cloudflare.panelDomain);
  const protection =
    connection &&
    cloudflare.accessProtection.status === 'confirmed_by_admin' &&
    cloudflare.accessProtection.confirmedHostname === cloudflare.panelDomain;
  const deployed =
    (overview.stats?.running ?? 0) > 0 ||
    (overview.projects ?? []).some((project) =>
      Boolean(project.activeDeploymentId),
    );
  return {
    server,
    connection,
    protection,
    github: githubConnected,
    deployed,
    complete: server && connection && protection && deployed,
  };
}
