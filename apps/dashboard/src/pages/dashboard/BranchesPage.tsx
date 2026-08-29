import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Spinner, Switch } from "@spruvex-r/ui";

import { api } from "../../lib/api";

interface OrderingSettings {
  qrOrderingEnabled?: boolean;
  requireCashierConfirmation?: boolean;
}

interface Branch {
  id: string;
  name: string;
  nameEn?: string;
  slug: string;
  address?: string;
  phone?: string;
  isActive: boolean;
  orderingSettings: OrderingSettings;
}

interface TenantInfo {
  slug: string;
  publicBaseUrl: string;
}

export function BranchesPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const branches = useQuery({
    queryKey: ["branches"],
    queryFn: () => api<Branch[]>("/branches"),
  });
  const tenant = useQuery({
    queryKey: ["tenant"],
    queryFn: () => api<TenantInfo>("/tenant"),
  });

  const toggleQr = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api(`/branches/${id}/ordering-settings`, {
        method: "PATCH",
        body: JSON.stringify({ qrOrderingEnabled: enabled }),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["branches"] }),
  });

  function pickupLink(branch: Branch): string | null {
    if (!tenant.data?.publicBaseUrl) return null;
    return `${tenant.data.publicBaseUrl}/restaurant/${tenant.data.slug}/${branch.slug}`;
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">{t("branches.title")}</h1>
      {branches.isLoading && <Spinner />}
      {branches.data?.length === 0 && (
        <p className="text-muted-foreground">{t("branches.empty")}</p>
      )}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {branches.data?.map((branch) => {
          const qrEnabled = branch.orderingSettings?.qrOrderingEnabled !== false;
          const link = pickupLink(branch);
          return (
            <Card key={branch.id}>
              <CardHeader className="flex-row items-center justify-between">
                <CardTitle>{branch.name}</CardTitle>
                <Badge variant={branch.isActive ? "success" : "muted"}>
                  {branch.isActive ? t("branches.active") : t("branches.inactive")}
                </Badge>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <div className="space-y-1 text-muted-foreground">
                  {branch.address && (
                    <p>
                      {t("branches.address")}: {branch.address}
                    </p>
                  )}
                  {branch.phone && (
                    <p dir="ltr" className="text-start">
                      {branch.phone}
                    </p>
                  )}
                </div>

                <div className="flex items-center justify-between border-t pt-3">
                  <span className="font-medium">{t("branches.qrOrdering")}</span>
                  <Switch
                    checked={qrEnabled}
                    onCheckedChange={(enabled) => toggleQr.mutate({ id: branch.id, enabled })}
                  />
                </div>

                {link && (
                  <div className="flex items-center gap-2 rounded-md bg-muted p-2">
                    <span className="flex-1 truncate text-xs text-muted-foreground" dir="ltr">
                      {link}
                    </span>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => navigator.clipboard.writeText(link)}
                      title={t("branches.copyLink")}
                      aria-label={t("branches.copyLink")}
                    >
                      <Copy className="h-4 w-4" />
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
