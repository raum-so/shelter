import {
  Building2,
  Check,
  ChevronDown,
  ExternalLink,
  FolderGit2,
  LockKeyhole,
  Search,
  UserRound,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import type { GitHubInstallation, GitHubRepository, GitHubRepositoryCatalog } from '../types';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { trustedGitHubRemediationUrl } from '../utils/github';
import { Avatar, AvatarFallback, AvatarImage } from './ui/avatar';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from './ui/dialog';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { ScrollArea } from './ui/scroll-area';

export function githubRepositoryKey(repository: Pick<GitHubRepository, 'installationId' | 'id'>) {
  return `${repository.installationId}:${repository.id}`;
}

function installationName(installation: GitHubInstallation) {
  return installation.accountLogin ?? installation.account?.login ?? 'GitHub';
}

function installationAvatar(installation: GitHubInstallation) {
  return installation.accountAvatarUrl ?? installation.account?.avatarUrl;
}

function installationType(installation: GitHubInstallation) {
  return installation.accountType ?? installation.account?.type ?? 'Account';
}

function ownerInitials(owner: string) {
  return owner.slice(0, 2).toUpperCase();
}

export function GitHubRepositoryPicker({
  catalog,
  value,
  onValueChange,
  disabled,
  error,
  id = 'github-repository',
}: {
  catalog: GitHubRepositoryCatalog;
  value: string;
  onValueChange: (repository: GitHubRepository) => void;
  disabled?: boolean;
  error?: string;
  id?: string;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [installationFilter, setInstallationFilter] = useState('all');
  const selected = catalog.repositories.find((repository) => githubRepositoryKey(repository) === value);

  const installations = useMemo(() => [...catalog.installations]
    .filter((installation) => !installation.suspendedAt)
    .sort((left, right) => {
      const typeOrder = Number(installationType(right) === 'Organization') - Number(installationType(left) === 'Organization');
      return typeOrder || installationName(left).localeCompare(installationName(right));
    }), [catalog.installations]);

  const repositoryCounts = useMemo(() => new Map(installations.map((installation) => [
    String(installation.id),
    catalog.repositories.filter((repository) => String(repository.installationId) === String(installation.id)).length,
  ])), [catalog.repositories, installations]);

  const repositories = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return [...catalog.repositories]
      .filter((repository) => installationFilter === 'all' || String(repository.installationId) === installationFilter)
      .filter((repository) => !needle || repository.fullName.toLocaleLowerCase().includes(needle))
      .sort((left, right) => left.fullName.localeCompare(right.fullName));
  }, [catalog.repositories, installationFilter, query]);

  const groupedRepositories = useMemo(() => {
    const groups = new Map<string, GitHubRepository[]>();
    for (const repository of repositories) {
      const current = groups.get(repository.owner) ?? [];
      current.push(repository);
      groups.set(repository.owner, current);
    }
    return [...groups.entries()];
  }, [repositories]);

  const activeInstallation = installationFilter === 'all'
    ? undefined
    : installations.find((installation) => String(installation.id) === installationFilter);
  const activeInstallationUrl = trustedGitHubRemediationUrl(activeInstallation?.htmlUrl);

  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>{t('Repository', 'Repository')}</Label>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <Button
            id={id}
            type="button"
            variant="outline"
            disabled={disabled}
            aria-invalid={Boolean(error)}
            aria-describedby={error ? `${id}-error` : undefined}
            className={cn(
              'h-auto min-h-11 w-full justify-between gap-3 px-3 py-2 text-left font-normal',
              error && 'border-destructive ring-destructive/20',
            )}
          >
            {selected ? (
              <span className="flex min-w-0 items-center gap-3">
                <span className="grid size-8 shrink-0 place-items-center rounded-md border bg-muted/35">
                  <FolderGit2 className="size-4" aria-hidden="true" />
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">{selected.fullName}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {selected.private ? t('Private repository', 'Privates Repository') : t('Public repository', 'Öffentliches Repository')}
                    {' · '}{selected.defaultBranch}
                  </span>
                </span>
              </span>
            ) : (
              <span className="flex items-center gap-3 text-muted-foreground">
                <span className="grid size-8 place-items-center rounded-md border bg-muted/25">
                  <FolderGit2 className="size-4" aria-hidden="true" />
                </span>
                {t('Choose a repository', 'Repository auswählen')}
              </span>
            )}
            <ChevronDown className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          </Button>
        </DialogTrigger>

        <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-3xl">
          <DialogHeader className="border-b px-5 py-4 pr-12">
            <DialogTitle>{t('Choose a GitHub repository', 'GitHub-Repository auswählen')}</DialogTitle>
            <DialogDescription>
              {t(
                'Select an account or organization, then choose the repository Shelter should deploy.',
                'Wähle einen Account oder eine Organisation und anschließend das Repository, das Shelter deployen soll.',
              )}
            </DialogDescription>
          </DialogHeader>

          <div className="grid min-h-[28rem] md:grid-cols-[13.5rem_minmax(0,1fr)]">
            <aside className="border-b bg-muted/20 p-2 md:border-r md:border-b-0" aria-label={t('GitHub accounts', 'GitHub-Accounts')}>
              <div className="flex gap-1 overflow-x-auto md:grid md:overflow-visible">
                <button
                  type="button"
                  onClick={() => setInstallationFilter('all')}
                  className={cn(
                    'flex min-w-40 items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors md:min-w-0',
                    installationFilter === 'all' ? 'bg-background shadow-xs ring-1 ring-border' : 'hover:bg-muted/60',
                  )}
                >
                  <span className="grid size-8 shrink-0 place-items-center rounded-md border bg-background"><FolderGit2 className="size-4" /></span>
                  <span className="min-w-0 flex-1">
                    <strong className="block truncate text-sm font-medium">{t('All repositories', 'Alle Repositories')}</strong>
                    <span className="block text-xs text-muted-foreground">{catalog.repositories.length}</span>
                  </span>
                </button>

                {installations.map((installation) => {
                  const key = String(installation.id);
                  const name = installationName(installation);
                  const organization = installationType(installation) === 'Organization';
                  return (
                    <button
                      type="button"
                      key={key}
                      onClick={() => setInstallationFilter(key)}
                      className={cn(
                        'flex min-w-40 items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors md:min-w-0',
                        installationFilter === key ? 'bg-background shadow-xs ring-1 ring-border' : 'hover:bg-muted/60',
                      )}
                    >
                      <Avatar className="size-8 rounded-md">
                        {installationAvatar(installation) && <AvatarImage src={installationAvatar(installation)} alt="" className="rounded-md" />}
                        <AvatarFallback className="rounded-md">{ownerInitials(name)}</AvatarFallback>
                      </Avatar>
                      <span className="min-w-0 flex-1">
                        <strong className="block truncate text-sm font-medium">{name}</strong>
                        <span className="flex items-center gap-1 text-xs text-muted-foreground">
                          {organization ? <Building2 className="size-3" /> : <UserRound className="size-3" />}
                          {repositoryCounts.get(key) ?? 0}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </aside>

            <section className="grid min-w-0 grid-rows-[auto_minmax(0,1fr)_auto]">
              <div className="border-b p-3">
                <div className="relative">
                  <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
                  <Input
                    autoFocus
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder={t('Search by owner or repository …', 'Nach Owner oder Repository suchen …')}
                    className="pl-9"
                    aria-label={t('Search repositories', 'Repositories durchsuchen')}
                  />
                </div>
              </div>

              <ScrollArea className="h-[21rem]">
                {groupedRepositories.length > 0 ? (
                  <div className="p-2">
                    {groupedRepositories.map(([owner, ownerRepositories]) => (
                      <section key={owner} className="mb-3 last:mb-0" aria-labelledby={`github-owner-${owner}`}>
                        <div className="flex items-center justify-between px-2 py-1.5">
                          <h3 id={`github-owner-${owner}`} className="text-xs font-medium text-muted-foreground">{owner}</h3>
                          <span className="text-xs tabular-nums text-muted-foreground">{ownerRepositories.length}</span>
                        </div>
                        <div className="grid gap-1">
                          {ownerRepositories.map((repository) => {
                            const key = githubRepositoryKey(repository);
                            const checked = key === value;
                            return (
                              <button
                                type="button"
                                key={key}
                                onClick={() => {
                                  onValueChange(repository);
                                  setOpen(false);
                                }}
                                className={cn(
                                  'group flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors',
                                  checked ? 'bg-primary/8 text-foreground' : 'hover:bg-muted/55',
                                )}
                              >
                                <span className={cn(
                                  'grid size-8 shrink-0 place-items-center rounded-md border bg-background text-muted-foreground',
                                  checked && 'border-primary/30 text-primary',
                                )}>
                                  <FolderGit2 className="size-4" aria-hidden="true" />
                                </span>
                                <span className="min-w-0 flex-1">
                                  <span className="flex min-w-0 items-center gap-2">
                                    <strong className="truncate text-sm font-medium">{repository.name}</strong>
                                    {repository.private && <LockKeyhole className="size-3.5 shrink-0 text-muted-foreground" aria-label={t('Private', 'Privat')} />}
                                  </span>
                                  <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                                    {t('Default branch', 'Standard-Branch')}: {repository.defaultBranch}
                                  </span>
                                </span>
                                {checked && <Check className="size-4 shrink-0 text-primary" aria-hidden="true" />}
                              </button>
                            );
                          })}
                        </div>
                      </section>
                    ))}
                  </div>
                ) : (
                  <div className="grid h-full place-items-center p-8 text-center">
                    <div>
                      <span className="mx-auto grid size-10 place-items-center rounded-full border bg-muted/30"><Search className="size-4 text-muted-foreground" /></span>
                      <strong className="mt-3 block text-sm">{t('No matching repository', 'Kein passendes Repository')}</strong>
                      <p className="mt-1 max-w-xs text-xs leading-5 text-muted-foreground">
                        {query
                          ? t('Try a different owner or repository name.', 'Versuche einen anderen Owner- oder Repository-Namen.')
                          : t('This installation does not currently share any repositories with Shelter.', 'Diese Installation teilt aktuell keine Repositories mit Shelter.')}
                      </p>
                    </div>
                  </div>
                )}
              </ScrollArea>

              <div className="flex items-center justify-between gap-3 border-t bg-muted/15 px-4 py-3">
                <p className="truncate text-xs text-muted-foreground">
                  {activeInstallation
                    ? t('{count} repositories from {account}', '{count} Repositories von {account}', {
                        count: repositories.length,
                        account: installationName(activeInstallation),
                      })
                    : t('{count} repositories across {accounts} accounts', '{count} Repositories aus {accounts} Accounts', {
                        count: repositories.length,
                        accounts: installations.length,
                      })}
                </p>
                {activeInstallationUrl && (
                  <Button asChild size="sm" variant="ghost" className="shrink-0">
                    <a href={activeInstallationUrl} target="_blank" rel="noreferrer">
                      {t('Manage access', 'Zugriff verwalten')} <ExternalLink aria-hidden="true" />
                    </a>
                  </Button>
                )}
              </div>
            </section>
          </div>
        </DialogContent>
      </Dialog>
      {error && <p id={`${id}-error`} className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
