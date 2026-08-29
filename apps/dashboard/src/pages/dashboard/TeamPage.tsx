import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Button, Card, CardContent, Dialog, Input, Label, Select, Spinner } from "@spruvex-r/ui";

import { api, ApiError } from "../../lib/api";

interface Member {
  userId: string;
  name: string;
  email: string;
  isActive: boolean;
  lastLoginAt: string | null;
  role: { key: string; nameAr: string; nameEn: string };
  branch: { id: string; name: string } | null;
}

interface Role {
  key: string;
  nameAr: string;
  nameEn: string;
  isSystem: boolean;
}

interface Branch {
  id: string;
  name: string;
}

interface MemberForm {
  name: string;
  email: string;
  password: string;
  role: string;
  branchId: string;
}

const emptyForm: MemberForm = { name: "", email: "", password: "", role: "", branchId: "" };

export function TeamPage() {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ["users"],
    queryFn: () => api<Member[]>("/users"),
  });
  const { data: roles } = useQuery({
    queryKey: ["roles"],
    queryFn: () => api<Role[]>("/roles"),
  });
  const { data: branches } = useQuery({
    queryKey: ["branches"],
    queryFn: () => api<Branch[]>("/branches"),
  });

  const assignableRoles = (roles ?? []).filter((r) => r.key !== "owner");

  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<MemberForm>(emptyForm);
  const [error, setError] = useState<string | null>(null);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["users"] });

  const add = useMutation({
    mutationFn: () =>
      api<Member>("/users", {
        method: "POST",
        body: JSON.stringify({
          name: form.name,
          email: form.email,
          password: form.password,
          role: form.role,
          ...(form.branchId ? { branchId: form.branchId } : {}),
        }),
      }),
    onSuccess: async () => {
      await invalidate();
      setOpen(false);
      setForm(emptyForm);
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : t("common.error")),
  });

  const remove = useMutation({
    mutationFn: (userId: string) => api(`/users/${userId}`, { method: "DELETE" }),
    onSuccess: invalidate,
    onError: (e) => alert(e instanceof ApiError ? e.message : t("common.error")),
  });

  function openDialog() {
    setError(null);
    setForm({ ...emptyForm, role: assignableRoles[0]?.key ?? "" });
    setOpen(true);
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    add.mutate();
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">{t("team.title")}</h1>
        <Button onClick={openDialog}>
          <Plus className="h-4 w-4" /> {t("team.add")}
        </Button>
      </div>
      {isLoading && <Spinner />}
      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50 text-start">
                  <th className="p-3 text-start font-medium">{t("auth.name")}</th>
                  <th className="p-3 text-start font-medium">{t("auth.email")}</th>
                  <th className="p-3 text-start font-medium">{t("team.role")}</th>
                  <th className="p-3 text-start font-medium">{t("team.branch")}</th>
                  <th className="p-3 text-start font-medium">{t("team.lastLogin")}</th>
                  <th className="p-3 text-start font-medium" />
                </tr>
              </thead>
              <tbody>
                {data?.map((member) => (
                  <tr key={`${member.userId}-${member.role.key}`} className="border-b last:border-0">
                    <td className="p-3 font-medium">{member.name}</td>
                    <td className="p-3 text-muted-foreground" dir="ltr">
                      {member.email}
                    </td>
                    <td className="p-3">
                      <span className="rounded-full bg-secondary px-2 py-0.5 text-xs text-secondary-foreground">
                        {i18n.language === "ar" ? member.role.nameAr : member.role.nameEn}
                      </span>
                    </td>
                    <td className="p-3 text-muted-foreground">
                      {member.branch?.name ?? t("team.allBranches")}
                    </td>
                    <td className="p-3 text-muted-foreground">
                      {member.lastLoginAt
                        ? new Date(member.lastLoginAt).toLocaleString(
                            i18n.language === "ar" ? "ar-SA" : "en-US",
                          )
                        : t("team.never")}
                    </td>
                    <td className="p-3 text-end">
                      {member.role.key !== "owner" && (
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => {
                            if (confirm(t("team.confirmRemove"))) remove.mutate(member.userId);
                          }}
                        >
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <Dialog open={open} onClose={() => setOpen(false)} title={t("team.add")}>
        <form onSubmit={submit} className="space-y-4">
          {error && <Alert variant="destructive">{error}</Alert>}
          <div className="space-y-2">
            <Label htmlFor="mname">{t("auth.name")}</Label>
            <Input
              id="mname"
              required
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="memail">{t("auth.email")}</Label>
            <Input
              id="memail"
              type="email"
              dir="ltr"
              required
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="mpass">{t("auth.password")}</Label>
            <Input
              id="mpass"
              type="password"
              dir="ltr"
              required
              minLength={8}
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
            />
            <p className="text-xs text-muted-foreground">{t("team.passwordHint")}</p>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="mrole">{t("team.role")}</Label>
              <Select
                id="mrole"
                required
                value={form.role}
                onChange={(e) => setForm({ ...form, role: e.target.value })}
              >
                {assignableRoles.map((role) => (
                  <option key={role.key} value={role.key}>
                    {i18n.language === "ar" ? role.nameAr : role.nameEn}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="mbranch">{t("team.branch")}</Label>
              <Select
                id="mbranch"
                value={form.branchId}
                onChange={(e) => setForm({ ...form, branchId: e.target.value })}
              >
                <option value="">{t("team.allBranches")}</option>
                {branches?.map((branch) => (
                  <option key={branch.id} value={branch.id}>
                    {branch.name}
                  </option>
                ))}
              </Select>
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              {t("catalog.cancel")}
            </Button>
            <Button type="submit" disabled={add.isPending}>
              {add.isPending ? <Spinner className="border-primary-foreground" /> : t("common.save")}
            </Button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}
