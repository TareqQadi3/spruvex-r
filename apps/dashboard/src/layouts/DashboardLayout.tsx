import { useQuery } from "@tanstack/react-query";
import {
  BarChart3,
  BookOpen,
  ChefHat,
  CreditCard,
  Home,
  Languages,
  LayoutGrid,
  LogOut,
  Monitor,
  Package,
  Puzzle,
  Receipt,
  Settings,
  Store,
  Users,
  type LucideIcon,
} from "lucide-react";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { NavLink, Outlet, useNavigate } from "react-router-dom";

import { Button, applyThemeColor, cn } from "@spruvex-r/ui";

import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { NAV_ITEMS, visibleNavItems } from "../lib/nav";

const ICONS: Record<string, LucideIcon> = {
  home: Home,
  store: Store,
  users: Users,
  settings: Settings,
  "book-open": BookOpen,
  "layout-grid": LayoutGrid,
  receipt: Receipt,
  monitor: Monitor,
  "chef-hat": ChefHat,
  "bar-chart": BarChart3,
  package: Package,
  "credit-card": CreditCard,
  puzzle: Puzzle,
};

export function DashboardLayout() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const canSeeTenant = Boolean(user?.permissions.includes("tenant.settings.manage"));

  const { data: tenant } = useQuery({
    queryKey: ["tenant"],
    queryFn: () => api<{ themeColor?: string | null }>("/tenant"),
    enabled: canSeeTenant,
  });
  useEffect(() => {
    if (tenant) applyThemeColor(tenant.themeColor);
  }, [tenant]);

  const items = visibleNavItems(NAV_ITEMS, user?.permissions ?? []);

  return (
    <div className="flex min-h-screen">
      {/* Sidebar */}
      <aside className="hidden w-64 shrink-0 flex-col border-e bg-card sm:flex">
        <div className="flex h-16 items-center border-b px-5">
          <img src="/logo-horizontal.png" alt="SpruVex R" className="h-9 object-contain" />
        </div>
        <nav className="flex-1 space-y-1 overflow-y-auto p-3">
          {items.map((item) => {
            const Icon = ICONS[item.icon] ?? Home;
            if (item.comingSoon) {
              return (
                <div
                  key={item.path}
                  className="flex cursor-not-allowed items-center gap-3 rounded-md px-3 py-2 text-sm text-muted-foreground/60"
                  title={t("common.comingSoon")}
                >
                  <Icon className="h-4 w-4" />
                  <span className="flex-1">{t(`nav.${item.labelKey}`)}</span>
                  <span className="rounded-full bg-muted px-2 py-0.5 text-[10px]">
                    {t("common.comingSoon")}
                  </span>
                </div>
              );
            }
            return (
              <NavLink
                key={item.path}
                to={item.path}
                end={item.path === "/"}
                className={({ isActive }) =>
                  cn(
                    "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                    isActive
                      ? "bg-primary text-primary-foreground"
                      : "text-foreground hover:bg-muted",
                  )
                }
              >
                <Icon className="h-4 w-4" />
                {t(`nav.${item.labelKey}`)}
              </NavLink>
            );
          })}
        </nav>
      </aside>

      {/* Main column */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-16 items-center justify-between border-b bg-card px-4">
          <div className="text-sm font-medium sm:hidden">
            <img src="/logo-horizontal.png" alt="SpruVex R" className="h-8 object-contain" />
          </div>
          <div className="hidden text-sm text-muted-foreground sm:block">{t("app.tagline")}</div>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => i18n.changeLanguage(i18n.language === "ar" ? "en" : "ar")}
            >
              <Languages className="h-4 w-4" />
              {t("common.language")}
            </Button>
            <span className="hidden text-sm font-medium sm:inline">{user?.name}</span>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t("common.logout")}
              onClick={() => {
                void logout().then(() => navigate("/login", { replace: true }));
              }}
            >
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
