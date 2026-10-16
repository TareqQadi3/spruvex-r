import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";

import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  Dialog,
  Input,
  Label,
  Spinner,
  Switch,
} from "@spruvex-r/ui";

import { ApiError } from "../../lib/api";
import {
  catalogApi,
  localizedName,
  type ModifierGroup,
  type ModifierOption,
} from "../../lib/catalog-api";

interface GroupForm {
  name: string;
  nameEn: string;
  isRequired: boolean;
  minSelect: number;
  maxSelect: string; // empty = unlimited
}

interface ModifierForm {
  name: string;
  nameEn: string;
  priceAdjustment: string;
}

const emptyGroup: GroupForm = { name: "", nameEn: "", isRequired: false, minSelect: 0, maxSelect: "" };
const emptyModifier: ModifierForm = { name: "", nameEn: "", priceAdjustment: "0" };

export function ModifiersPage() {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ["catalog", "modifier-groups"],
    queryFn: catalogApi.listModifierGroups,
  });

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["catalog", "modifier-groups"] });

  // --- group editor state ---
  const [groupEditor, setGroupEditor] = useState<ModifierGroup | "new" | null>(null);
  const [groupForm, setGroupForm] = useState<GroupForm>(emptyGroup);
  const [groupError, setGroupError] = useState<string | null>(null);

  const saveGroup = useMutation({
    mutationFn: async () => {
      const body = {
        name: groupForm.name,
        ...(groupForm.nameEn ? { nameEn: groupForm.nameEn } : {}),
        isRequired: groupForm.isRequired,
        minSelect: groupForm.minSelect,
        ...(groupForm.maxSelect !== "" ? { maxSelect: Number(groupForm.maxSelect) } : {}),
      };
      if (groupEditor === "new") {
        await catalogApi.createModifierGroup(body);
      } else if (groupEditor) {
        await catalogApi.updateModifierGroup(groupEditor.id, body);
      }
    },
    onSuccess: async () => {
      await invalidate();
      setGroupEditor(null);
    },
    onError: (e) => setGroupError(e instanceof ApiError ? e.message : t("common.error")),
  });

  const deleteGroup = useMutation({
    mutationFn: (id: string) => catalogApi.deleteModifierGroup(id),
    onSuccess: invalidate,
    onError: (e) => alert(e instanceof ApiError ? e.message : t("common.error")),
  });

  // --- modifier editor state ---
  const [modifierEditor, setModifierEditor] = useState<
    { groupId: string; modifier: ModifierOption | "new" } | null
  >(null);
  const [modifierForm, setModifierForm] = useState<ModifierForm>(emptyModifier);
  const [modifierError, setModifierError] = useState<string | null>(null);

  const saveModifier = useMutation({
    mutationFn: async () => {
      if (!modifierEditor) return;
      const body = {
        name: modifierForm.name,
        ...(modifierForm.nameEn ? { nameEn: modifierForm.nameEn } : {}),
        priceAdjustment: modifierForm.priceAdjustment || "0",
      };
      if (modifierEditor.modifier === "new") {
        await catalogApi.createModifier(modifierEditor.groupId, body);
      } else {
        await catalogApi.updateModifier(modifierEditor.modifier.id, body);
      }
    },
    onSuccess: async () => {
      await invalidate();
      setModifierEditor(null);
    },
    onError: (e) => setModifierError(e instanceof ApiError ? e.message : t("common.error")),
  });

  const deleteModifier = useMutation({
    mutationFn: (id: string) => catalogApi.deleteModifier(id),
    onSuccess: invalidate,
    onError: (e) => alert(e instanceof ApiError ? e.message : t("common.error")),
  });

  function openGroupEditor(group: ModifierGroup | "new") {
    setGroupError(null);
    setGroupEditor(group);
    setGroupForm(
      group === "new"
        ? emptyGroup
        : {
            name: group.name,
            nameEn: group.nameEn ?? "",
            isRequired: group.isRequired,
            minSelect: group.minSelect,
            maxSelect: group.maxSelect == null ? "" : String(group.maxSelect),
          },
    );
  }

  function openModifierEditor(groupId: string, modifier: ModifierOption | "new") {
    setModifierError(null);
    setModifierEditor({ groupId, modifier });
    setModifierForm(
      modifier === "new"
        ? emptyModifier
        : {
            name: modifier.name,
            nameEn: modifier.nameEn ?? "",
            priceAdjustment: modifier.priceAdjustment,
          },
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">{t("catalog.modifiers.title")}</h2>
        <Button onClick={() => openGroupEditor("new")}>
          <Plus className="h-4 w-4" /> {t("catalog.modifiers.addGroup")}
        </Button>
      </div>

      {isLoading && <Spinner />}
      {data?.length === 0 && (
        <p className="text-muted-foreground">{t("catalog.modifiers.empty")}</p>
      )}

      <div className="space-y-4">
        {data?.map((group) => (
          <Card key={group.id}>
            <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
              <div className="flex items-center gap-2">
                <span className="font-semibold">{localizedName(group, i18n.language)}</span>
                <Badge variant={group.isRequired ? "success" : "muted"}>
                  {group.isRequired
                    ? t("catalog.modifiers.required")
                    : t("catalog.modifiers.optional")}
                </Badge>
                <span className="text-xs text-muted-foreground" dir="ltr">
                  {group.minSelect}–{group.maxSelect ?? "∞"}
                </span>
                <span className="text-xs text-muted-foreground">
                  {t("catalog.modifiers.attachedTo", { count: group._count?.products ?? 0 })}
                </span>
              </div>
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => openModifierEditor(group.id, "new")}
                >
                  <Plus className="h-4 w-4" /> {t("catalog.modifiers.addModifier")}
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  title={t("catalog.edit")}
                  aria-label={t("catalog.edit")}
                  onClick={() => openGroupEditor(group)}
                >
                  <Pencil className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  title={t("catalog.delete")}
                  aria-label={t("catalog.delete")}
                  onClick={() => {
                    if (confirm(t("catalog.confirmDelete"))) deleteGroup.mutate(group.id);
                  }}
                >
                  <Trash2 className="h-4 w-4 text-destructive" />
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              {group.modifiers.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {t("catalog.modifiers.noModifiers")}
                </p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {group.modifiers.map((modifier) => (
                    <div
                      key={modifier.id}
                      className="flex items-center gap-2 rounded-full border px-3 py-1 text-sm"
                    >
                      <span>{localizedName(modifier, i18n.language)}</span>
                      <span className="text-xs text-muted-foreground" dir="ltr">
                        {Number(modifier.priceAdjustment) >= 0 ? "+" : ""}
                        {modifier.priceAdjustment}
                      </span>
                      <button
                        type="button"
                        className="text-muted-foreground hover:text-foreground"
                        onClick={() => openModifierEditor(group.id, modifier)}
                        aria-label={t("catalog.edit")}
                      >
                        <Pencil className="h-3 w-3" />
                      </button>
                      <button
                        type="button"
                        className="text-muted-foreground hover:text-destructive"
                        onClick={() => {
                          if (confirm(t("catalog.confirmDelete")))
                            deleteModifier.mutate(modifier.id);
                        }}
                        aria-label={t("catalog.delete")}
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Group editor dialog */}
      <Dialog
        open={groupEditor !== null}
        onClose={() => setGroupEditor(null)}
        title={
          groupEditor === "new"
            ? t("catalog.modifiers.addGroup")
            : t("catalog.modifiers.editGroup")
        }
      >
        <form
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            saveGroup.mutate();
          }}
          className="space-y-4"
        >
          {groupError && <Alert variant="destructive">{groupError}</Alert>}
          <div className="space-y-2">
            <Label htmlFor="gname">{t("catalog.nameAr")}</Label>
            <Input
              id="gname"
              required
              value={groupForm.name}
              onChange={(e) => setGroupForm({ ...groupForm, name: e.target.value })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="gnameEn">{t("catalog.nameEn")}</Label>
            <Input
              id="gnameEn"
              dir="ltr"
              value={groupForm.nameEn}
              onChange={(e) => setGroupForm({ ...groupForm, nameEn: e.target.value })}
            />
          </div>
          <div className="flex items-center gap-2">
            <Switch
              checked={groupForm.isRequired}
              aria-label={t("catalog.modifiers.required")}
              onCheckedChange={(isRequired) =>
                setGroupForm({
                  ...groupForm,
                  isRequired,
                  minSelect: isRequired && groupForm.minSelect < 1 ? 1 : groupForm.minSelect,
                })
              }
            />
            <span className="text-sm">{t("catalog.modifiers.required")}</span>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="gmin">{t("catalog.modifiers.minSelect")}</Label>
              <Input
                id="gmin"
                type="number"
                min={0}
                value={groupForm.minSelect}
                onChange={(e) =>
                  setGroupForm({ ...groupForm, minSelect: Number(e.target.value) })
                }
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="gmax">{t("catalog.modifiers.maxSelect")}</Label>
              <Input
                id="gmax"
                type="number"
                min={1}
                value={groupForm.maxSelect}
                onChange={(e) => setGroupForm({ ...groupForm, maxSelect: e.target.value })}
              />
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setGroupEditor(null)}>
              {t("catalog.cancel")}
            </Button>
            <Button type="submit" disabled={saveGroup.isPending}>
              {saveGroup.isPending ? (
                <Spinner className="border-primary-foreground" />
              ) : (
                t("common.save")
              )}
            </Button>
          </div>
        </form>
      </Dialog>

      {/* Modifier editor dialog */}
      <Dialog
        open={modifierEditor !== null}
        onClose={() => setModifierEditor(null)}
        title={
          modifierEditor?.modifier === "new"
            ? t("catalog.modifiers.addModifier")
            : t("catalog.modifiers.editModifier")
        }
      >
        <form
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            saveModifier.mutate();
          }}
          className="space-y-4"
        >
          {modifierError && <Alert variant="destructive">{modifierError}</Alert>}
          <div className="space-y-2">
            <Label htmlFor="mname">{t("catalog.nameAr")}</Label>
            <Input
              id="mname"
              required
              value={modifierForm.name}
              onChange={(e) => setModifierForm({ ...modifierForm, name: e.target.value })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="mnameEn">{t("catalog.nameEn")}</Label>
            <Input
              id="mnameEn"
              dir="ltr"
              value={modifierForm.nameEn}
              onChange={(e) => setModifierForm({ ...modifierForm, nameEn: e.target.value })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="mprice">{t("catalog.modifiers.priceAdjustment")} (SAR)</Label>
            <Input
              id="mprice"
              dir="ltr"
              inputMode="decimal"
              placeholder="5.00"
              value={modifierForm.priceAdjustment}
              onChange={(e) =>
                setModifierForm({ ...modifierForm, priceAdjustment: e.target.value })
              }
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setModifierEditor(null)}>
              {t("catalog.cancel")}
            </Button>
            <Button type="submit" disabled={saveModifier.isPending}>
              {saveModifier.isPending ? (
                <Spinner className="border-primary-foreground" />
              ) : (
                t("common.save")
              )}
            </Button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}
