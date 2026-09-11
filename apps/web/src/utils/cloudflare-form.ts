export function normalizePanelHostname(value: string) {
  return value.trim().toLowerCase().replace(/^https?:\/\//, '').split('/')[0]?.replace(/\.$/, '') ?? '';
}

export function cloudflareRoutingChanged(
  form: { accountId: string; tunnelName: string; panelDomain: string },
  initial: { accountId: string; tunnelName: string | null | undefined; panelDomain: string | null | undefined },
) {
  return form.accountId.trim().toLowerCase() !== initial.accountId.trim().toLowerCase()
    || form.tunnelName.trim() !== (initial.tunnelName ?? 'shelter').trim()
    || normalizePanelHostname(form.panelDomain) !== normalizePanelHostname(initial.panelDomain ?? '');
}
