import type { CartLineInput, Menu, MenuModifier, MenuProduct } from "./types";

export interface LastOrderRecord {
  items: CartLineInput[];
  placedAt: string;
}

function storageKey(scope: string): string {
  return `spruvex:ordering:last-order:${scope}`;
}

/** Called right after a takeaway/delivery order is successfully placed — never for dine-in. */
export function saveLastOrder(scope: string, items: CartLineInput[]): void {
  try {
    const record: LastOrderRecord = { items, placedAt: new Date().toISOString() };
    localStorage.setItem(storageKey(scope), JSON.stringify(record));
  } catch {
    // best-effort convenience only — the order itself already succeeded
  }
}

export function loadLastOrder(scope: string): LastOrderRecord | null {
  try {
    const raw = localStorage.getItem(storageKey(scope));
    return raw ? (JSON.parse(raw) as LastOrderRecord) : null;
  } catch {
    return null;
  }
}

export interface RepeatableLine {
  product: MenuProduct;
  modifiers: MenuModifier[];
  quantity: number;
  notes?: string;
}

/**
 * Matches a stored last-order item list against the CURRENT menu — never
 * trusts cached names/prices. Any product that was deleted, disabled, or
 * hidden from this channel since the last order (so it's simply absent
 * from `menu.products`) is dropped rather than resurrected with stale
 * data; same for any modifier that no longer belongs to the product.
 */
export function matchAgainstCurrentMenu(record: LastOrderRecord, menu: Menu): RepeatableLine[] {
  const productById = new Map(menu.products.map((p) => [p.id, p]));
  const lines: RepeatableLine[] = [];
  for (const item of record.items) {
    const product = productById.get(item.productId);
    if (!product) continue;
    const availableModifiers = new Map(
      product.modifierGroups.flatMap((g) => g.modifiers.map((m) => [m.id, m] as const)),
    );
    const modifiers = (item.modifierIds ?? [])
      .map((id) => availableModifiers.get(id))
      .filter((m): m is MenuModifier => Boolean(m));
    // A required group's selection went missing (modifier removed) — skip
    // this line rather than submit something that no longer satisfies the
    // product's own selection rules (the real order-creation endpoint
    // would reject it anyway; better to silently drop it here).
    const stillSatisfiesRequiredGroups = product.modifierGroups
      .filter((g) => g.isRequired)
      .every((g) => {
        const selectedInGroup = modifiers.filter((m) => g.modifiers.some((gm) => gm.id === m.id)).length;
        return selectedInGroup >= Math.max(g.minSelect, 1);
      });
    if (!stillSatisfiesRequiredGroups) continue;
    lines.push({ product, modifiers, quantity: item.quantity, notes: item.notes });
  }
  return lines;
}
