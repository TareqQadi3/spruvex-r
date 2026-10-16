import { Building2, CreditCard, Languages, LogOut, Server, Settings } from "lucide-react";
import { useTranslation } from "react-i18next";
import { NavLink, Outlet } from "react-router-dom";

import { Button, cn } from "@spruvex-r/ui";

import { useAuth } from "../lib/auth";

const NAV = [
  { path: "/", labelKey: "nav.tenants", icon: Building2 },
  { path: "/subscriptions", labelKey: "nav.subscriptions", icon: CreditCard },
  { path: "/system", labelKey: "nav.system", icon: Server },
  { path: "/settings", labelKey: "nav.settings", icon: Settings },
];

export function PlatformLayout() {
  const { t, i18n } = useTranslation();
  const { admin, logout } = useAuth();

  return (
    <div className="flex min-h-screen">
      <aside className="hidden w-64 shrink-0 flex-col border-e bg-card sm:flex">
        <div className="flex h-16 items-center border-b px-5">
          <img src="/logo-horizontal.png" alt="SpruVex R" className="h-9 object-contain" />
        </div>
        <nav className="flex-1 space-y-1 overflow-y-auto p-3">
          {NAV.map((item) => (
            <NavLink
              key={item.path}
              to={item.path}
              end={item.path === "/"}
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                  isActive ? "bg-primary text-primary-foreground" : "text-foreground hover:bg-muted",
                )
              }
            >
              <item.icon className="h-4 w-4" />
              {t(item.labelKey)}
            </NavLink>
          ))}
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-16 items-center justify-between border-b bg-card px-4">
          <div className="text-sm font-medium sm:hidden">
            <img src="/logo-horizontal.png" alt="SpruVex R" className="h-8 object-contain" />
          </div>
          <div className="hidden text-sm text-muted-foreground sm:block">{t("app.name")}</div>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => i18n.changeLanguage(i18n.language === "ar" ? "en" : "ar")}
            >
              <Languages className="h-4 w-4" />
              {t("common.language")}
            </Button>
            <span className="hidden text-sm font-medium sm:inline">{admin?.name}</span>
            <Button variant="ghost" size="icon" aria-label={t("common.logout")} onClick={logout}>
              <LogOut className="h-4 w-4" />
            </Button>
          </div>
        </header>
        <main className="flex-1 p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
