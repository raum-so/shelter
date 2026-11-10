export function suggestSupabaseAddresses(name: string, domain: string) {
  const prefix =
    name
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 36)
      .replace(/-+$/g, "") || "supabase";
  return {
    api: domain ? `${prefix}-db.${domain}` : "",
    studio: domain ? `${prefix}-studio.${domain}` : "",
  };
}
