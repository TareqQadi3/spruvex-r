import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

import { Badge, Button, Card, CardContent, Select, Spinner } from "@spruvex-r/ui";

import { ApiError } from "../../lib/api";
import { catalogApi, localizedName } from "../../lib/catalog-api";

export function ProductsPage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [categoryFilter, setCategoryFilter] = useState("");

  const categories = useQuery({
    queryKey: ["catalog", "categories"],
    queryFn: catalogApi.listCategories,
  });
  const products = useQuery({
    queryKey: ["catalog", "products", categoryFilter],
    queryFn: () => catalogApi.listProducts(categoryFilter || undefined),
  });

  const remove = useMutation({
    mutationFn: (id: string) => catalogApi.deleteProduct(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["catalog", "products"] }),
    onError: (e) => alert(e instanceof ApiError ? e.message : t("common.error")),
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">{t("catalog.products.title")}</h2>
        <div className="flex items-center gap-2">
          <Select
            className="w-48"
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
          >
            <option value="">{t("catalog.products.allCategories")}</option>
            {categories.data?.map((category) => (
              <option key={category.id} value={category.id}>
                {localizedName(category, i18n.language)}
              </option>
            ))}
          </Select>
          <Button onClick={() => navigate("/menu/products/new")}>
            <Plus className="h-4 w-4" /> {t("catalog.products.add")}
          </Button>
        </div>
      </div>

      {products.isLoading && <Spinner />}
      {products.data?.length === 0 && (
        <p className="text-muted-foreground">{t("catalog.products.empty")}</p>
      )}

      {products.data && products.data.length > 0 && (
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className="p-3 text-start font-medium">{t("catalog.nameAr")}</th>
                    <th className="p-3 text-start font-medium">{t("catalog.products.sku")}</th>
                    <th className="p-3 text-start font-medium">{t("catalog.products.category")}</th>
                    <th className="p-3 text-start font-medium">{t("catalog.products.price")}</th>
                    <th className="p-3 text-start font-medium"></th>
                    <th className="p-3 text-start font-medium">{t("catalog.actions")}</th>
                  </tr>
                </thead>
                <tbody>
                  {products.data.map((product) => (
                    <tr key={product.id} className="border-b last:border-0 hover:bg-muted/30">
                      <td className="p-3">
                        <div className="font-medium">{localizedName(product, i18n.language)}</div>
                        {product.nameEn && (
                          <div className="text-xs text-muted-foreground" dir="ltr">
                            {product.nameEn}
                          </div>
                        )}
                      </td>
                      <td className="p-3 text-muted-foreground" dir="ltr">
                        {product.sku ?? "—"}
                      </td>
                      <td className="p-3 text-muted-foreground">
                        {localizedName(product.category, i18n.language)}
                      </td>
                      <td className="p-3 font-medium" dir="ltr">
                        {product.basePrice} SAR
                      </td>
                      <td className="p-3">
                        <Badge variant={product.isActive ? "success" : "muted"}>
                          {product.isActive ? t("catalog.active") : t("catalog.inactive")}
                        </Badge>
                      </td>
                      <td className="p-3">
                        <div className="flex items-center gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            title={t("catalog.edit")}
                            aria-label={t("catalog.edit")}
                            onClick={() => navigate(`/menu/products/${product.id}`)}
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            title={t("catalog.delete")}
                            aria-label={t("catalog.delete")}
                            onClick={() => {
                              if (confirm(t("catalog.confirmDelete"))) remove.mutate(product.id);
                            }}
                          >
                            <Trash2 className="h-4 w-4 text-destructive" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
