import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, Printer, QrCode, RefreshCw, Trash2, Users } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";

import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  Dialog,
  Input,
  Label,
  Select,
  Spinner,
  cn,
} from "@spruvex-r/ui";

import { ApiError, downloadFile } from "../../lib/api";
import { localizedName } from "../../lib/catalog-api";
import { tablesApi, type DiningTable, type TableStatus } from "../../lib/tables-api";

const STATUS_STYLES: Record<TableStatus, string> = {
  available: "border-primary/40 bg-primary/5",
  occupied: "border-destructive/40 bg-destructive/5",
  reserved: "border-amber-400/60 bg-amber-50",
  disabled: "border-border bg-muted/50 opacity-70",
};

const STATUS_BADGE: Record<TableStatus, "success" | "destructive" | "default" | "muted"> = {
  available: "success",
  occupied: "destructive",
  reserved: "default",
  disabled: "muted",
};

interface TableForm {
  floorId: string;
  number: string;
  capacity: number;
  status: TableStatus;
}

export function TablesPage() {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();

  const floors = useQuery({ queryKey: ["floors"], queryFn: () => tablesApi.listFloors() });
  const [floorFilter, setFloorFilter] = useState("");
  const tables = useQuery({
    queryKey: ["tables", floorFilter],
    queryFn: () => tablesApi.listTables(floorFilter ? { floorId: floorFilter } : {}),
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["tables"] });

  const [editing, setEditing] = useState<DiningTable | "new" | null>(null);
  const [form, setForm] = useState<TableForm>({
    floorId: "",
    number: "",
    capacity: 4,
    status: "available",
  });
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: async () => {
      if (editing === "new") {
        await tablesApi.createTable({
          floorId: form.floorId,
          number: form.number,
          capacity: form.capacity,
        });
      } else if (editing) {
        await tablesApi.updateTable(editing.id, {
          floorId: form.floorId,
          number: form.number,
          capacity: form.capacity,
          status: form.status,
        });
      }
    },
    onSuccess: async () => {
      await invalidate();
      setEditing(null);
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : t("common.error")),
  });

  const remove = useMutation({
    mutationFn: (id: string) => tablesApi.deleteTable(id),
    onSuccess: invalidate,
    onError: (e) => alert(e instanceof ApiError ? e.message : t("common.error")),
  });

  const regenerate = useMutation({
    mutationFn: (id: string) => tablesApi.regenerateQr(id),
    onSuccess: invalidate,
    onError: (e) => alert(e instanceof ApiError ? e.message : t("common.error")),
  });

  const session = useMutation({
    mutationFn: ({ id, action }: { id: string; action: "open" | "close" }) =>
      action === "open" ? tablesApi.openSession(id) : tablesApi.closeSession(id),
    onSuccess: invalidate,
    onError: (e) => alert(e instanceof ApiError ? e.message : t("common.error")),
  });

  function openEditor(table: DiningTable | "new") {
    setError(null);
    setEditing(table);
    setForm(
      table === "new"
        ? {
            floorId: floorFilter || (floors.data?.[0]?.id ?? ""),
            number: "",
            capacity: 4,
            status: "available",
          }
        : {
            floorId: table.floorId,
            number: table.number,
            capacity: table.capacity,
            status: table.status,
          },
    );
  }

  const activeFloors = floors.data?.filter((f) => f.isActive) ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">{t("tables.list.title")}</h2>
        <div className="flex flex-wrap items-center gap-2">
          <Select
            className="w-48"
            value={floorFilter}
            onChange={(e) => setFloorFilter(e.target.value)}
          >
            <option value="">{t("tables.tabs.floors")}: —</option>
            {floors.data?.map((floor) => (
              <option key={floor.id} value={floor.id}>
                {localizedName(floor, i18n.language)}
              </option>
            ))}
          </Select>
          <Button
            variant="outline"
            onClick={() =>
              downloadFile(
                `/tables/qr-sheet.pdf${floorFilter ? `?floorId=${floorFilter}` : ""}`,
                "spruvex-qr-tables.pdf",
              ).catch((e) => alert(e instanceof ApiError ? e.message : t("common.error")))
            }
          >
            <Printer className="h-4 w-4" /> {t("tables.qr.printSheet")}
          </Button>
          <Button onClick={() => openEditor("new")} disabled={activeFloors.length === 0}>
            <Plus className="h-4 w-4" /> {t("tables.list.add")}
          </Button>
        </div>
      </div>

      {tables.isLoading && <Spinner />}
      {tables.data?.length === 0 && (
        <p className="text-muted-foreground">{t("tables.list.empty")}</p>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
        {tables.data?.map((table) => (
          <Card key={table.id} className={cn("border-2", STATUS_STYLES[table.status])}>
            <CardContent className="space-y-2 p-4">
              <div className="flex items-center justify-between">
                <span className="text-xl font-bold">{table.number}</span>
                <Badge variant={STATUS_BADGE[table.status]}>
                  {t(`tables.list.status.${table.status}`)}
                </Badge>
              </div>
              <p className="text-xs text-muted-foreground">
                {localizedName(table.floor, i18n.language)}
              </p>
              <p className="flex items-center gap-1 text-xs text-muted-foreground">
                <Users className="h-3 w-3" />
                {t("tables.list.seats", { count: table.capacity })}
              </p>
              <div className="flex flex-wrap items-center gap-1 pt-1">
                <Button
                  variant="ghost"
                  size="icon"
                  title={t("tables.qr.download")}
                  aria-label={t("tables.qr.download")}
                  onClick={() =>
                    downloadFile(`/tables/${table.id}/qr.png`, `table-${table.number}-qr.png`).catch(
                      (e) => alert(e instanceof ApiError ? e.message : t("common.error")),
                    )
                  }
                >
                  <QrCode className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  title={t("tables.qr.regenerate")}
                  aria-label={t("tables.qr.regenerate")}
                  onClick={() => {
                    if (confirm(t("tables.qr.regenerateConfirm"))) regenerate.mutate(table.id);
                  }}
                >
                  <RefreshCw className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  title={t("catalog.edit")}
                  aria-label={t("catalog.edit")}
                  onClick={() => openEditor(table)}
                >
                  <Pencil className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  title={t("catalog.delete")}
                  aria-label={t("catalog.delete")}
                  onClick={() => {
                    if (confirm(t("catalog.confirmDelete"))) remove.mutate(table.id);
                  }}
                >
                  <Trash2 className="h-4 w-4 text-destructive" />
                </Button>
              </div>
              {table.status !== "disabled" && (
                <Button
                  variant={table.status === "occupied" ? "outline" : "secondary"}
                  size="sm"
                  className="w-full"
                  disabled={session.isPending}
                  onClick={() =>
                    session.mutate({
                      id: table.id,
                      action: table.status === "occupied" ? "close" : "open",
                    })
                  }
                >
                  {table.status === "occupied"
                    ? t("tables.list.closeSession")
                    : t("tables.list.openSession")}
                </Button>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      <Dialog
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing === "new" ? t("tables.list.add") : t("tables.list.editTitle")}
      >
        <form
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            save.mutate();
          }}
          className="space-y-4"
        >
          {error && <Alert variant="destructive">{error}</Alert>}
          <div className="space-y-2">
            <Label htmlFor="tfloor">{t("tables.list.floor")}</Label>
            <Select
              id="tfloor"
              required
              value={form.floorId}
              onChange={(e) => setForm({ ...form, floorId: e.target.value })}
            >
              {activeFloors.map((floor) => (
                <option key={floor.id} value={floor.id}>
                  {localizedName(floor, i18n.language)}
                </option>
              ))}
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="tnumber">{t("tables.list.number")}</Label>
              <Input
                id="tnumber"
                required
                maxLength={20}
                value={form.number}
                onChange={(e) => setForm({ ...form, number: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="tcapacity">{t("tables.list.capacity")}</Label>
              <Input
                id="tcapacity"
                type="number"
                min={1}
                max={100}
                value={form.capacity}
                onChange={(e) => setForm({ ...form, capacity: Number(e.target.value) })}
              />
            </div>
          </div>
          {editing !== "new" && (
            <div className="space-y-2">
              <Label htmlFor="tstatus">{t("catalog.actions")}</Label>
              <Select
                id="tstatus"
                value={form.status}
                onChange={(e) => setForm({ ...form, status: e.target.value as TableStatus })}
              >
                {(["available", "occupied", "reserved", "disabled"] as const).map((status) => (
                  <option key={status} value={status}>
                    {t(`tables.list.status.${status}`)}
                  </option>
                ))}
              </Select>
            </div>
          )}
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
