"use client";

import { cn } from "@spruvex-r/ui";

import { useLocalizedField } from "./LocaleProvider";
import type { MenuCategory } from "@/lib/types";

export function CategoryNav({
  categories,
  activeId,
  onSelect,
}: {
  categories: MenuCategory[];
  activeId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const name = useLocalizedField();

  return (
    <nav
      data-menu-part="category-nav"
      className="sticky top-[57px] z-10 flex gap-2 overflow-x-auto border-b bg-background/95 px-4 py-2 backdrop-blur"
    >
      {categories.map((category) => (
        <button
          key={category.id}
          type="button"
          data-menu-part="category-button"
          onClick={() => onSelect(category.id)}
          className={cn(
            "shrink-0 px-4 py-1.5 text-sm font-medium transition-colors",
            activeId !== category.id && "bg-muted text-muted-foreground",
          )}
          style={{
            borderRadius: "var(--menu-pill-radius, 9999px)",
            ...(activeId === category.id
              ? {
                  backgroundColor: "hsl(var(--menu-primary, var(--primary)))",
                  color: "hsl(var(--menu-primary-foreground, var(--primary-foreground)))",
                }
              : {}),
          }}
        >
          {name(category)}
        </button>
      ))}
    </nav>
  );
}
