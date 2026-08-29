import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import {
  createBrowserRouter,
  Navigate,
  RouterProvider,
} from "react-router-dom";

import { Spinner } from "@spruvex-r/ui";

import { AuthProvider, useAuth } from "./lib/auth";
import { DashboardLayout } from "./layouts/DashboardLayout";
import { ForgotPasswordPage } from "./pages/auth/ForgotPasswordPage";
import { LoginPage } from "./pages/auth/LoginPage";
import { RegisterPage } from "./pages/auth/RegisterPage";
import { BillingPage } from "./pages/dashboard/BillingPage";
import { BranchesPage } from "./pages/dashboard/BranchesPage";
import { HomePage } from "./pages/dashboard/HomePage";
import { SettingsPage } from "./pages/dashboard/SettingsPage";
import { TeamPage } from "./pages/dashboard/TeamPage";
import { IngredientsPage } from "./pages/inventory/IngredientsPage";
import { InventoryLayout } from "./pages/inventory/InventoryLayout";
import { StockPage } from "./pages/inventory/StockPage";
import { CategoriesPage } from "./pages/menu/CategoriesPage";
import { MenuLayout } from "./pages/menu/MenuLayout";
import { ModifiersPage } from "./pages/menu/ModifiersPage";
import { ProductEditorPage } from "./pages/menu/ProductEditorPage";
import { ProductsPage } from "./pages/menu/ProductsPage";
import { OnboardingWizard } from "./pages/onboarding/OnboardingWizard";
import { ReportsPage } from "./pages/reports/ReportsPage";
import { FloorsPage } from "./pages/tables/FloorsPage";
import { TablesLayout } from "./pages/tables/TablesLayout";
import { TablesPage } from "./pages/tables/TablesPage";

function FullScreenSpinner() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <Spinner className="h-8 w-8" />
    </div>
  );
}

/** Requires a signed-in session. */
function RequireAuth({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  if (status === "loading") return <FullScreenSpinner />;
  if (status === "guest") return <Navigate to="/login" replace />;
  return <>{children}</>;
}

/** Requires a signed-in session with completed onboarding. */
function RequireOnboarded({ children }: { children: ReactNode }) {
  const { status, user } = useAuth();
  if (status === "loading") return <FullScreenSpinner />;
  if (status === "guest") return <Navigate to="/login" replace />;
  if (!user?.onboardingCompleted) return <Navigate to="/onboarding" replace />;
  return <>{children}</>;
}

/** Redirects signed-in users away from auth pages. */
function GuestOnly({ children }: { children: ReactNode }) {
  const { status, user } = useAuth();
  if (status === "loading") return <FullScreenSpinner />;
  if (status === "authenticated") {
    return <Navigate to={user?.onboardingCompleted ? "/" : "/onboarding"} replace />;
  }
  return <>{children}</>;
}

const router = createBrowserRouter([
  {
    path: "/login",
    element: (
      <GuestOnly>
        <LoginPage />
      </GuestOnly>
    ),
  },
  {
    path: "/register",
    element: (
      <GuestOnly>
        <RegisterPage />
      </GuestOnly>
    ),
  },
  {
    path: "/forgot-password",
    element: (
      <GuestOnly>
        <ForgotPasswordPage />
      </GuestOnly>
    ),
  },
  {
    path: "/onboarding",
    element: (
      <RequireAuth>
        <OnboardingWizard />
      </RequireAuth>
    ),
  },
  {
    path: "/",
    element: (
      <RequireOnboarded>
        <DashboardLayout />
      </RequireOnboarded>
    ),
    children: [
      { index: true, element: <HomePage /> },
      { path: "branches", element: <BranchesPage /> },
      { path: "team", element: <TeamPage /> },
      { path: "settings", element: <SettingsPage /> },
      { path: "billing", element: <BillingPage /> },
      {
        path: "menu",
        element: <MenuLayout />,
        children: [
          { index: true, element: <Navigate to="/menu/categories" replace /> },
          { path: "categories", element: <CategoriesPage /> },
          { path: "products", element: <ProductsPage /> },
          { path: "products/new", element: <ProductEditorPage /> },
          { path: "products/:id", element: <ProductEditorPage /> },
          { path: "modifiers", element: <ModifiersPage /> },
        ],
      },
      {
        path: "tables",
        element: <TablesLayout />,
        children: [
          { index: true, element: <TablesPage /> },
          { path: "floors", element: <FloorsPage /> },
        ],
      },
      {
        path: "inventory",
        element: <InventoryLayout />,
        children: [
          { index: true, element: <IngredientsPage /> },
          { path: "stock", element: <StockPage /> },
        ],
      },
      { path: "reports", element: <ReportsPage /> },
      { path: "*", element: <Navigate to="/" replace /> },
    ],
  },
]);

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <RouterProvider router={router} />
      </AuthProvider>
    </QueryClientProvider>
  );
}
