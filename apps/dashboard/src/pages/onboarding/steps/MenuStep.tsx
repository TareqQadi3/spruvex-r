import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Button, ImageInput, Input, Label, Spinner } from "@spruvex-r/ui";

import { ApiError, uploadImage } from "../../../lib/api";
import { catalogApi } from "../../../lib/catalog-api";
import type { StepProps } from "./step-types";

export function MenuStep({ onDone, onSkip }: StepProps) {
  const { t } = useTranslation();
  const [categoryName, setCategoryName] = useState("");
  const [categoryImage, setCategoryImage] = useState("");
  const [productName, setProductName] = useState("");
  const [productPrice, setProductPrice] = useState("");
  const [productImage, setProductImage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!categoryName || !productName || !productPrice) return;
    setBusy(true);
    setError(null);
    try {
      const category = await catalogApi.createCategory({
        name: categoryName,
        ...(categoryImage ? { imageUrl: categoryImage } : {}),
      });
      await catalogApi.createProduct({
        name: productName,
        basePrice: productPrice,
        categoryId: category.id,
        ...(productImage ? { imageUrl: productImage } : {}),
      });
      await onDone();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t("common.error"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      {error && <Alert variant="destructive">{error}</Alert>}
      <div className="space-y-2">
        <Label htmlFor="menu-category-name">{t("onboarding.menuCategoryName")}</Label>
        <p className="text-xs text-muted-foreground">{t("onboarding.menuCategoryNameHint")}</p>
        <Input
          id="menu-category-name"
          required
          value={categoryName}
          onChange={(e) => setCategoryName(e.target.value)}
        />
      </div>
      <ImageInput
        label={t("catalog.imageUrl")}
        value={categoryImage}
        onChange={setCategoryImage}
        onUploadFile={uploadImage}
        uploadTabLabel={t("common.uploadTab")}
        urlTabLabel={t("common.urlTab")}
        uploadButtonLabel={t("common.uploadButton")}
        removeLabel={t("common.removeImage")}
        errorFallback={t("common.uploadError")}
        constraintsHint={t("common.imageConstraints")}
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="menu-product-name">{t("onboarding.menuProductName")}</Label>
          <p className="text-xs text-muted-foreground">{t("onboarding.menuProductNameHint")}</p>
          <Input
            id="menu-product-name"
            required
            value={productName}
            onChange={(e) => setProductName(e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="menu-product-price">{t("onboarding.menuProductPrice")}</Label>
          <p className="text-xs text-muted-foreground">{t("onboarding.menuProductPriceHint")}</p>
          <Input
            id="menu-product-price"
            required
            dir="ltr"
            type="number"
            min="0"
            step="0.01"
            value={productPrice}
            onChange={(e) => setProductPrice(e.target.value)}
          />
        </div>
      </div>
      <ImageInput
        label={t("catalog.imageUrl")}
        value={productImage}
        onChange={setProductImage}
        onUploadFile={uploadImage}
        uploadTabLabel={t("common.uploadTab")}
        urlTabLabel={t("common.urlTab")}
        uploadButtonLabel={t("common.uploadButton")}
        removeLabel={t("common.removeImage")}
        errorFallback={t("common.uploadError")}
        constraintsHint={t("common.imageConstraints")}
      />

      <div className="flex gap-3">
        <Button type="submit" className="flex-1" disabled={busy}>
          {busy ? <Spinner className="border-primary-foreground" /> : t("common.save")}
        </Button>
        <Button type="button" variant="outline" className="flex-1" onClick={() => void onSkip()} disabled={busy}>
          {t("onboarding.hubSkip")}
        </Button>
      </div>
    </form>
  );
}
