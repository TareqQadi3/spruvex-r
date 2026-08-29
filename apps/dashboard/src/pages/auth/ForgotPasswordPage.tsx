import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router-dom";

import {
  Alert,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Spinner,
} from "@spruvex-r/ui";

import { ApiError, api, post } from "../../lib/api";
import { AuthShell } from "./AuthShell";

/** Two-step self-service password reset: request a code, then set a new password. */
export function ForgotPasswordPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const [stage, setStage] = useState<"request" | "reset">("request");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [devOtp, setDevOtp] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submitRequest(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await post<{ devOtp?: string }>("/auth/forgot-password", { email });
      setDevOtp(res.devOtp);
      setStage("reset");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t("common.error"));
    } finally {
      setBusy(false);
    }
  }

  async function submitReset(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api("/auth/reset-password", {
        method: "POST",
        body: JSON.stringify({ email, code, newPassword }),
      });
      navigate("/login", { replace: true });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t("common.error"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell>
      <Card className="w-full max-w-md">
        <CardHeader className="items-center text-center">
          <img src="/logo-horizontal.png" alt="SpruVex R" className="mb-2 h-14 object-contain" />
          <CardTitle>{t("auth.forgotTitle")}</CardTitle>
          <CardDescription>
            {stage === "request" ? t("auth.forgotSubtitle") : t("auth.otpSubtitle")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {stage === "request" ? (
            <form onSubmit={submitRequest} className="space-y-4">
              {error && <Alert variant="destructive">{error}</Alert>}
              <div className="space-y-2">
                <Label htmlFor="email">{t("auth.email")}</Label>
                <Input
                  id="email"
                  type="email"
                  dir="ltr"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>
              <Button type="submit" className="w-full" disabled={busy}>
                {busy ? <Spinner className="border-primary-foreground" /> : t("auth.forgotSend")}
              </Button>
              <p className="text-center text-sm text-muted-foreground">
                <Link to="/login" className="font-medium text-primary hover:underline">
                  {t("auth.backToLogin")}
                </Link>
              </p>
            </form>
          ) : (
            <form onSubmit={submitReset} className="space-y-4">
              {error && <Alert variant="destructive">{error}</Alert>}
              {devOtp && (
                <Alert>
                  {t("auth.otpDevHint")} <strong dir="ltr">{devOtp}</strong>
                </Alert>
              )}
              <div className="space-y-2">
                <Label htmlFor="code">{t("auth.otpCode")}</Label>
                <Input
                  id="code"
                  dir="ltr"
                  inputMode="numeric"
                  maxLength={6}
                  className="text-center text-lg tracking-[0.5em]"
                  required
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="newPassword">{t("auth.forgotNewPassword")}</Label>
                <Input
                  id="newPassword"
                  type="password"
                  dir="ltr"
                  autoComplete="new-password"
                  required
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">{t("auth.passwordRule")}</p>
              </div>
              <Button type="submit" className="w-full" disabled={busy || code.length !== 6}>
                {busy ? <Spinner className="border-primary-foreground" /> : t("auth.forgotSubmit")}
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </AuthShell>
  );
}
