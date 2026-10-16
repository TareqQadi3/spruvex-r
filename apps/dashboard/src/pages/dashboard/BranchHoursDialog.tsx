import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Badge, Button, Dialog, Input, Label, Switch } from "@spruvex-r/ui";
import { WEEKDAY_KEYS, type WeekdayKey } from "@spruvex-r/types";

import { api } from "../../lib/api";

interface TimeRange {
  from: string;
  to: string;
}
type Schedule = Partial<Record<WeekdayKey, TimeRange[]>>;

interface WorkingHours {
  schedule?: Schedule;
  channelSchedule?: Record<string, Schedule>;
  exceptions?: unknown[];
}

interface ChannelStatus {
  channel: "dine_in" | "takeaway" | "delivery";
  open: boolean;
  reason: string;
  label?: string;
  pausedUntil: string | null;
  pausedReason: string | null;
  systemBusy: boolean;
}

interface BranchHoursResponse {
  workingHours: WorkingHours;
  statuses: ChannelStatus[];
}

interface DeliverySettings {
  deliveryFeeAmount?: string;
  deliveryMinOrderAmount?: string;
  deliveryRadiusKm?: string | null;
  deliveryEstimatedMinutes?: number;
  pickupEstimatedMinutes?: number;
  selfServicePaymentMethods?: ("cash" | "online")[];
  autoSlowdownThreshold?: number | null;
  autoPauseThreshold?: number | null;
}

const CHANNELS: ChannelStatus["channel"][] = ["dine_in", "takeaway", "delivery"];

export function BranchHoursDialog({
  branchId,
  open,
  onClose,
}: {
  branchId: string;
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [schedule, setSchedule] = useState<Schedule>({});
  const [delivery, setDelivery] = useState<DeliverySettings>({});
  const [pausing, setPausing] = useState<Record<string, { reason: string; minutes: string }>>({});

  const hours = useQuery({
    queryKey: ["branch-hours", branchId],
    queryFn: () => api<BranchHoursResponse>(`/branches/${branchId}/hours`),
    enabled: open,
  });

  useEffect(() => {
    if (hours.data) {
      setSchedule(hours.data.workingHours.schedule ?? {});
    }
  }, [hours.data]);

  const branches = useQuery({
    queryKey: ["branches"],
    queryFn: () => api<{ id: string; deliveryFeeAmount: string; deliveryMinOrderAmount: string; deliveryRadiusKm: string | null; deliveryEstimatedMinutes: number; pickupEstimatedMinutes: number; selfServicePaymentMethods: ("cash" | "online")[]; autoSlowdownThreshold: number | null; autoPauseThreshold: number | null }[]>("/branches"),
    enabled: open,
  });

  useEffect(() => {
    const b = branches.data?.find((x) => x.id === branchId);
    if (b) {
      setDelivery({
        deliveryFeeAmount: b.deliveryFeeAmount,
        deliveryMinOrderAmount: b.deliveryMinOrderAmount,
        deliveryRadiusKm: b.deliveryRadiusKm,
        deliveryEstimatedMinutes: b.deliveryEstimatedMinutes,
        pickupEstimatedMinutes: b.pickupEstimatedMinutes,
        selfServicePaymentMethods: b.selfServicePaymentMethods,
        autoSlowdownThreshold: b.autoSlowdownThreshold,
        autoPauseThreshold: b.autoPauseThreshold,
      });
    }
  }, [branches.data, branchId]);

  const saveHours = useMutation({
    mutationFn: () =>
      api(`/branches/${branchId}/hours`, {
        method: "PATCH",
        body: JSON.stringify({
          workingHours: {
            schedule,
            channelSchedule: hours.data?.workingHours.channelSchedule ?? {},
            exceptions: hours.data?.workingHours.exceptions ?? [],
          },
        }),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["branch-hours", branchId] }),
  });

  const saveDelivery = useMutation({
    mutationFn: () =>
      api(`/branches/${branchId}/delivery-settings`, { method: "PATCH", body: JSON.stringify(delivery) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["branches"] }),
  });

  const pause = useMutation({
    mutationFn: ({ channel, reason, minutes }: { channel: string; reason: string; minutes: string }) =>
      api(`/branches/${branchId}/pause`, {
        method: "POST",
        body: JSON.stringify({
          channel,
          reason: reason || undefined,
          durationMinutes: minutes ? Number(minutes) : undefined,
        }),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["branch-hours", branchId] }),
  });

  const resume = useMutation({
    mutationFn: (channel: string) => api(`/branches/${branchId}/resume/${channel}`, { method: "POST" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["branch-hours", branchId] }),
  });

  function addRange(day: WeekdayKey) {
    setSchedule((prev) => ({ ...prev, [day]: [...(prev[day] ?? []), { from: "09:00", to: "22:00" }] }));
  }
  function removeRange(day: WeekdayKey, index: number) {
    setSchedule((prev) => ({ ...prev, [day]: (prev[day] ?? []).filter((_, i) => i !== index) }));
  }
  function updateRange(day: WeekdayKey, index: number, field: "from" | "to", value: string) {
    setSchedule((prev) => ({
      ...prev,
      [day]: (prev[day] ?? []).map((r, i) => (i === index ? { ...r, [field]: value } : r)),
    }));
  }

  return (
    <Dialog open={open} onClose={onClose} title={t("branches.hoursDialog.title")} className="max-w-2xl">
      <div className="max-h-[70vh] space-y-6 overflow-y-auto p-1">
        {/* --- Channel status + emergency pause --- */}
        <section className="space-y-2">
          <h3 className="font-semibold">{t("branches.hoursDialog.channels")}</h3>
          {CHANNELS.map((channel) => {
            const status = hours.data?.statuses.find((s) => s.channel === channel);
            const isPaused = status?.reason === "paused";
            return (
              <div key={channel} className="flex items-center justify-between rounded-md border p-2">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{t(`branches.hoursDialog.channel.${channel}`)}</span>
                  <Badge variant={status?.open ? "success" : "destructive"}>
                    {status?.open ? t("branches.hoursDialog.open") : t("branches.hoursDialog.closed")}
                  </Badge>
                  {status?.systemBusy && <Badge variant="muted">{t("branches.hoursDialog.busy")}</Badge>}
                </div>
                {isPaused ? (
                  <Button size="sm" variant="outline" onClick={() => resume.mutate(channel)}>
                    {t("branches.hoursDialog.resume")}
                  </Button>
                ) : (
                  <div className="flex items-center gap-1">
                    <Input
                      placeholder={t("branches.hoursDialog.reason")}
                      className="h-8 w-32 text-xs"
                      value={pausing[channel]?.reason ?? ""}
                      onChange={(e) =>
                        setPausing((p) => ({ ...p, [channel]: { reason: e.target.value, minutes: p[channel]?.minutes ?? "" } }))
                      }
                    />
                    <Input
                      placeholder={t("branches.hoursDialog.minutes")}
                      className="h-8 w-20 text-xs"
                      type="number"
                      value={pausing[channel]?.minutes ?? ""}
                      onChange={(e) =>
                        setPausing((p) => ({ ...p, [channel]: { reason: p[channel]?.reason ?? "", minutes: e.target.value } }))
                      }
                    />
                    <Button
                      size="sm"
                      variant="destructive"
                      onClick={() =>
                        pause.mutate({
                          channel,
                          reason: pausing[channel]?.reason ?? "",
                          minutes: pausing[channel]?.minutes ?? "",
                        })
                      }
                    >
                      {t("branches.hoursDialog.pause")}
                    </Button>
                  </div>
                )}
              </div>
            );
          })}
        </section>

        {/* --- Weekly schedule --- */}
        <section className="space-y-2">
          <h3 className="font-semibold">{t("branches.hoursDialog.weeklySchedule")}</h3>
          <p className="text-xs text-muted-foreground">{t("branches.hoursDialog.weeklyHint")}</p>
          {WEEKDAY_KEYS.map((day) => (
            <div key={day} className="flex flex-wrap items-center gap-2 border-b pb-2">
              <span className="w-16 text-sm font-medium">{t(`branches.hoursDialog.day.${day}`)}</span>
              <div className="flex flex-1 flex-wrap gap-2">
                {(schedule[day] ?? []).map((range, index) => (
                  <div key={index} className="flex items-center gap-1">
                    <Input
                      type="time"
                      className="h-8 w-28"
                      value={range.from}
                      onChange={(e) => updateRange(day, index, "from", e.target.value)}
                    />
                    <span className="text-xs">-</span>
                    <Input
                      type="time"
                      className="h-8 w-28"
                      value={range.to}
                      onChange={(e) => updateRange(day, index, "to", e.target.value)}
                    />
                    <Button size="icon" variant="ghost" onClick={() => removeRange(day, index)}>
                      ×
                    </Button>
                  </div>
                ))}
                <Button size="sm" variant="outline" onClick={() => addRange(day)}>
                  + {t("branches.hoursDialog.addShift")}
                </Button>
              </div>
            </div>
          ))}
          <Button onClick={() => saveHours.mutate()} disabled={saveHours.isPending}>
            {t("branches.hoursDialog.saveHours")}
          </Button>
          {Object.values(schedule).every((r) => !r || r.length === 0) && (
            <p className="text-xs text-amber-600">{t("branches.hoursDialog.emptyMeansAlwaysOpen")}</p>
          )}
        </section>

        {/* --- Delivery/pickup settings --- */}
        <section className="space-y-2">
          <h3 className="font-semibold">{t("branches.hoursDialog.deliverySettings")}</h3>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>{t("branches.hoursDialog.feeAmount")}</Label>
              <Input
                value={delivery.deliveryFeeAmount ?? ""}
                onChange={(e) => setDelivery((d) => ({ ...d, deliveryFeeAmount: e.target.value }))}
              />
            </div>
            <div>
              <Label>{t("branches.hoursDialog.minOrder")}</Label>
              <Input
                value={delivery.deliveryMinOrderAmount ?? ""}
                onChange={(e) => setDelivery((d) => ({ ...d, deliveryMinOrderAmount: e.target.value }))}
              />
            </div>
            <div>
              <Label>{t("branches.hoursDialog.radiusKm")}</Label>
              <Input
                value={delivery.deliveryRadiusKm ?? ""}
                placeholder={t("branches.hoursDialog.noLimit")}
                onChange={(e) => setDelivery((d) => ({ ...d, deliveryRadiusKm: e.target.value || null }))}
              />
            </div>
            <div>
              <Label>{t("branches.hoursDialog.deliveryEta")}</Label>
              <Input
                type="number"
                value={delivery.deliveryEstimatedMinutes ?? ""}
                onChange={(e) => setDelivery((d) => ({ ...d, deliveryEstimatedMinutes: Number(e.target.value) }))}
              />
            </div>
            <div>
              <Label>{t("branches.hoursDialog.pickupEta")}</Label>
              <Input
                type="number"
                value={delivery.pickupEstimatedMinutes ?? ""}
                onChange={(e) => setDelivery((d) => ({ ...d, pickupEstimatedMinutes: Number(e.target.value) }))}
              />
            </div>
            <div>
              <Label>{t("branches.hoursDialog.autoSlowdown")}</Label>
              <Input
                type="number"
                value={delivery.autoSlowdownThreshold ?? ""}
                placeholder={t("branches.hoursDialog.off")}
                onChange={(e) =>
                  setDelivery((d) => ({ ...d, autoSlowdownThreshold: e.target.value ? Number(e.target.value) : null }))
                }
              />
            </div>
          </div>
          <div className="flex items-center gap-4">
            {(["cash", "online"] as const).map((method) => (
              <label key={method} className="flex items-center gap-2 text-sm">
                <Switch
                  checked={delivery.selfServicePaymentMethods?.includes(method) ?? false}
                  onCheckedChange={(checked) =>
                    setDelivery((d) => {
                      const set = new Set(d.selfServicePaymentMethods ?? []);
                      if (checked) {
                        set.add(method);
                      } else {
                        set.delete(method);
                      }
                      return { ...d, selfServicePaymentMethods: [...set] };
                    })
                  }
                />
                {t(`branches.hoursDialog.paymentMethod.${method}`)}
              </label>
            ))}
          </div>
          <Button onClick={() => saveDelivery.mutate()} disabled={saveDelivery.isPending}>
            {t("branches.hoursDialog.saveDelivery")}
          </Button>
        </section>
      </div>
    </Dialog>
  );
}
