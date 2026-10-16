"use client";

import Image from "next/image";

import { Button } from "@spruvex-r/ui";

import { useLocale } from "./LocaleProvider";

export function MenuHeader({
  logoUrl,
  name,
  nameEn,
  subtitle,
}: {
  logoUrl: string | null;
  name: string;
  nameEn: string | null;
  subtitle?: string;
}) {
  const { locale, t, toggle } = useLocale();
  const title = locale === "en" && nameEn ? nameEn : name;

  return (
    <header
      data-menu-part="header"
      className="sticky top-0 z-20 flex items-center justify-between border-b bg-card/95 px-4 py-3 backdrop-blur"
    >
      <div className="flex min-w-0 items-center gap-2">
        {logoUrl ? (
          // Restaurant-provided URL — plain img avoids Next/Image remote-domain config per tenant.
          <img
            data-menu-part="logo"
            src={logoUrl}
            alt={title}
            className="h-9 w-9 rounded-full object-cover"
          />
        ) : (
          <Image
            data-menu-part="logo"
            src="/app-icon.png"
            alt={title}
            width={36}
            height={36}
            className="rounded-full"
          />
        )}
        <div className="min-w-0">
          <h1
            data-menu-part="title"
            className="truncate text-base leading-tight"
            style={{
              fontFamily: 'var(--menu-heading-font, "IBM Plex Sans Arabic", "Inter", system-ui, sans-serif)',
              fontWeight: "var(--menu-heading-weight, 700)",
            }}
          >
            {title}
          </h1>
          {subtitle && <p className="truncate text-xs text-muted-foreground">{subtitle}</p>}
        </div>
      </div>
      <Button variant="ghost" size="sm" onClick={toggle}>
        {t("common.language")}
      </Button>
    </header>
  );
}
