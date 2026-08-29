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

import { ApiError, post } from "../../lib/api";
import { useAuth, type SessionUser } from "../../lib/auth";
import { AuthShell } from "./AuthShell";

interface LoginResponse {
  user: SessionUser;
  tokens: { accessToken: string; refreshToken: string };
}

export function LoginPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { adoptSession } = useAuth();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await post<LoginResponse>("/auth/login", { email, password });
      const user = await adoptSession(res.tokens);
      navigate(user.onboardingCompleted ? "/" : "/onboarding", { replace: true });
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
          <CardTitle>{t("auth.loginTitle")}</CardTitle>
          <CardDescription>{t("auth.loginSubtitle")}</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="space-y-4">
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
            <div className="space-y-2">
              <Label htmlFor="password">{t("auth.password")}</Label>
              <Input
                id="password"
                type="password"
                dir="ltr"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <p className="text-end text-sm">
                <Link to="/forgot-password" className="text-primary hover:underline">
                  {t("auth.forgotLink")}
                </Link>
              </p>
            </div>
            <Button type="submit" className="w-full" disabled={busy}>
              {busy ? <Spinner className="border-primary-foreground" /> : t("auth.login")}
            </Button>
            <p className="text-center text-sm text-muted-foreground">
              {t("auth.noAccount")}{" "}
              <Link to="/register" className="font-medium text-primary hover:underline">
                {t("auth.register")}
              </Link>
            </p>
          </form>
        </CardContent>
      </Card>
    </AuthShell>
  );
}
