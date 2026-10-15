import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Badge, Button, Card, CardContent, Dialog, Input, Label, Spinner } from "@spruvex-r/ui";

import { ApiError } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import {
  marketingApi,
  type Coupon,
  type CouponChannel,
  type CouponDiscountType,
} from "../../lib/marketing-api";

interface CouponForm {
  code: string;
  discountType: CouponDiscountType;
  discountValue: string;
  maxDiscountAmount: string;
  minOrderAmount: string;
  channels: CouponChannel[];
  endAt: string;
  maxRedemptions: string;
  maxRedemptionsPerCustomer: string;
}

const emptyForm: CouponForm = {
  code: "",
  discountType: "percentage",
  discountValue: "",
  maxDiscountAmount: "",
  minOrderAmount: "",
  channels: [],
  endAt: "",
  maxRedemptions: "",
  maxRedemptionsPerCustomer: "",
};

const CHANNEL_OPTIONS: CouponChannel[] = ["takeaway", "delivery"];

export function CouponsPage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const canManage = Boolean(user?.permissions.includes("marketing.manage_coupons"));
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ["marketing", "coupons"],
    queryFn: marketingApi.listCoupons,
  });

  const [editing, setEditing] = useState<Coupon | "new" | null>(null);
  const [form, setForm] = useState<CouponForm>(emptyForm);
  const [error, setError] = useState<string | null>(null);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["marketing", "coupons"] });

  const save = useMutation({
    mutationFn: async () => {
      const body = {
        discountType: form.discountType,
        discountValue: form.discountValue,
        ...(form.maxDiscountAmount ? { maxDiscountAmount: form.maxDiscountAmount } : {}),
        ...(form.minOrderAmount ? { minOrderAmount: form.minOrderAmount } : {}),
        channels: form.channels,
        ...(form.endAt ? { endAt: new Date(form.endAt).toISOString() } : {}),
        ...(form.maxRedemptions ? { maxRedemptions: Number(form.maxRedemptions) } : {}),
        ...(form.maxRedemptionsPerCustomer
          ? { maxRedemptionsPerCustomer: Number(form.maxRedemptionsPerCustomer) }
          : {}),
      };
      if (editing === "new") {
        await marketingApi.createCoupon({ ...body, code: form.code });
      } else if (editing) {
        await marketingApi.updateCoupon(editing.id, body);
      }
    },
    onSuccess: async () => {
      await invalidate();
      setEditing(null);
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : t("common.error")),
  });

  const toggleActive = useMutation({
    mutationFn: (coupon: Coupon) => marketingApi.updateCoupon(coupon.id, { isActive: !coupon.isActive }),
    onSuccess: invalidate,
    onError: (e) => alert(e instanceof ApiError ? e.message : t("common.error")),
  });

  const remove = useMutation({
    mutationFn: (coupon: Coupon) => marketingApi.deleteCoupon(coupon.id),
    onSuccess: invalidate,
    onError: (e) => alert(e instanceof ApiError ? e.message : t("common.error")),
  });

  function openEditor(coupon: Coupon | "new") {
    setError(null);
    setEditing(coupon);
    setForm(
      coupon === "new"
        ? emptyForm
        : {
            code: coupon.code,
            discountType: coupon.discountType,
            discountValue: coupon.discountValue,
            maxDiscountAmount: coupon.maxDiscountAmount ?? "",
            minOrderAmount: coupon.minOrderAmount === "0" ? "" : coupon.minOrderAmount,
            channels: coupon.channels,
            endAt: coupon.endAt ? coupon.endAt.slice(0, 10) : "",
            maxRedemptions: coupon.maxRedemptions?.toString() ?? "",
            maxRedemptionsPerCustomer: coupon.maxRedemptionsPerCustomer?.toString() ?? "",
          },
    );
  }

  function toggleChannel(channel: CouponChannel) {
    setForm((f) => ({
      ...f,
      channels: f.channels.includes(channel)
        ? f.channels.filter((c) => c !== channel)
        : [...f.channels, channel],
    }));
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    save.mutate();
  }

  function describe(coupon: Coupon): string {
    const value =
      coupon.discountType === "percentage" ? `${coupon.discountValue}%` : `${coupon.discountValue} ${t("common.sar")}`;
    return t("marketing.coupons.discountSummary", { value });
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">{t("marketing.coupons.title")}</h2>
        {canManage && (
          <Button onClick={() => openEditor("new")}>
            <Plus className="h-4 w-4" /> {t("marketing.coupons.add")}
          </Button>
        )}
      </div>
      <p className="text-sm text-muted-foreground">{t("marketing.coupons.hint")}</p>

      {isLoading && <Spinner />}
      {data?.length === 0 && <p className="text-muted-foreground">{t("marketing.coupons.empty")}</p>}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {data?.map((coupon) => (
          <Card key={coupon.id} className={coupon.isActive ? undefined : "opacity-60"}>
            <CardContent className="space-y-2 p-4">
              <div className="flex items-start justify-between gap-2">
                <p className="font-mono text-sm font-semibold" dir="ltr">
                  {coupon.code}
                </p>
                {!coupon.isActive && <Badge variant="muted">{t("marketing.coupons.inactive")}</Badge>}
              </div>
              <p className="text-sm">{describe(coupon)}</p>
              {Number(coupon.minOrderAmount) > 0 && (
                <p className="text-xs text-muted-foreground">
                  {t("marketing.coupons.minOrder", { amount: coupon.minOrderAmount })}
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                {coupon.channels.length === 0
                  ? t("marketing.coupons.allChannels")
                  : coupon.channels.map((c) => t(`marketing.coupons.channel.${c}`)).join(" / ")}
              </p>
              {(coupon.maxRedemptions != null || coupon.maxRedemptionsPerCustomer != null) && (
                <p className="text-xs text-muted-foreground">
                  {coupon.maxRedemptions != null &&
                    t("marketing.coupons.maxRedemptions", { n: coupon.maxRedemptions })}
                  {coupon.maxRedemptions != null && coupon.maxRedemptionsPerCustomer != null && " · "}
                  {coupon.maxRedemptionsPerCustomer != null &&
                    t("marketing.coupons.maxPerCustomer", { n: coupon.maxRedemptionsPerCustomer })}
                </p>
              )}
              {canManage && (
                <div className="flex justify-end gap-1 pt-1">
                  <Button variant="ghost" size="icon" aria-label={t("catalog.edit")} onClick={() => openEditor(coupon)}>
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => toggleActive.mutate(coupon)}>
                    {coupon.isActive ? t("marketing.coupons.deactivate") : t("marketing.coupons.activate")}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      if (confirm(t("marketing.coupons.confirmDelete"))) remove.mutate(coupon);
                    }}
                  >
                    {t("common.delete")}
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      <Dialog
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing === "new" ? t("marketing.coupons.add") : t("marketing.coupons.editTitle")}
      >
        <form onSubmit={submit} className="space-y-4">
          {error && <Alert variant="destructive">{error}</Alert>}
          <div className="space-y-2">
            <Label htmlFor="ccode">{t("marketing.coupons.code")}</Label>
            <Input
              id="ccode"
              dir="ltr"
              required
              disabled={editing !== "new"}
              placeholder="WELCOME10"
              value={form.code}
              onChange={(e) => setForm({ ...form, code: e.target.value })}
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="ctype">{t("marketing.coupons.discountType")}</Label>
              <select
                id="ctype"
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={form.discountType}
                onChange={(e) => setForm({ ...form, discountType: e.target.value as CouponDiscountType })}
              >
                <option value="percentage">{t("marketing.coupons.percentage")}</option>
                <option value="fixed">{t("marketing.coupons.fixed")}</option>
              </select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="cvalue">{t("marketing.coupons.discountValue")}</Label>
              <Input
                id="cvalue"
                dir="ltr"
                required
                type="number"
                min="0"
                step="0.01"
                value={form.discountValue}
                onChange={(e) => setForm({ ...form, discountValue: e.target.value })}
              />
            </div>
          </div>
          {form.discountType === "percentage" && (
            <div className="space-y-2">
              <Label htmlFor="cmax">{t("marketing.coupons.maxDiscountAmount")}</Label>
              <Input
                id="cmax"
                dir="ltr"
                type="number"
                min="0"
                step="0.01"
                placeholder={t("common.optional")}
                value={form.maxDiscountAmount}
                onChange={(e) => setForm({ ...form, maxDiscountAmount: e.target.value })}
              />
            </div>
          )}
          <div className="space-y-2">
            <Label htmlFor="cmin">{t("marketing.coupons.minOrderAmount")}</Label>
            <Input
              id="cmin"
              dir="ltr"
              type="number"
              min="0"
              step="0.01"
              placeholder={t("common.optional")}
              value={form.minOrderAmount}
              onChange={(e) => setForm({ ...form, minOrderAmount: e.target.value })}
            />
          </div>
          <div className="space-y-2">
            <Label>{t("marketing.coupons.channels")}</Label>
            <div className="flex gap-3">
              {CHANNEL_OPTIONS.map((channel) => (
                <label key={channel} className="flex items-center gap-1.5 text-sm">
                  <input
                    type="checkbox"
                    checked={form.channels.includes(channel)}
                    onChange={() => toggleChannel(channel)}
                  />
                  {t(`marketing.coupons.channel.${channel}`)}
                </label>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">{t("marketing.coupons.channelsHint")}</p>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="cend">{t("marketing.coupons.endAt")}</Label>
              <Input
                id="cend"
                type="date"
                value={form.endAt}
                onChange={(e) => setForm({ ...form, endAt: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="cmaxred">{t("marketing.coupons.maxRedemptionsLabel")}</Label>
              <Input
                id="cmaxred"
                dir="ltr"
                type="number"
                min="1"
                placeholder={t("common.unlimited")}
                value={form.maxRedemptions}
                onChange={(e) => setForm({ ...form, maxRedemptions: e.target.value })}
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="cmaxpercust">{t("marketing.coupons.maxPerCustomerLabel")}</Label>
            <Input
              id="cmaxpercust"
              dir="ltr"
              type="number"
              min="1"
              placeholder={t("common.unlimited")}
              value={form.maxRedemptionsPerCustomer}
              onChange={(e) => setForm({ ...form, maxRedemptionsPerCustomer: e.target.value })}
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setEditing(null)}>
              {t("catalog.cancel")}
            </Button>
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? <Spinner className="border-primary-foreground" /> : t("common.save")}
            </Button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}
