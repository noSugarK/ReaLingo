export interface SearchOption {
  value: string;
  label: string;
  note?: string;
  /** Alternate names or descriptions, including other interface languages. */
  keywords?: string;
}

/** Keep the original items and order so selection metadata survives filtering. */
export function filterOptions<T extends SearchOption>(options: T[], query: string): T[] {
  const needle = query.trim().toLowerCase();
  return needle ? options.filter(option =>
    `${option.value} ${option.label} ${option.note ?? ""} ${option.keywords ?? ""}`.toLowerCase().includes(needle)
  ) : options;
}
