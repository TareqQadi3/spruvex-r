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
  // Set when login hit the "Email not verified" guard: offer in-place
  // verification (enter the code / resend) instead of a dead end — the user
  // HAS an account, it just never finished the email-confirmation step.
  const [needsVerification, setNeedsVerification] = useState(false);
  const [code, setCode] = useState("");
  const [resent, setResent] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setResent(false);
    setBusy(true);
    try {
      const res = await post<LoginResponse>("/auth/login", { email, password });
      const user = await adoptSession(res.tokens);
      navigate(user.onboardingCompleted ? "/" : "/onboarding", { replace: true });
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) {
        setNeedsVerification(true);
      } else {
        setError(e instanceof ApiError ? e.message : t("common.error"));
      }
    } finally {
      setBusy(false);
    }
  }

  async function onVerify(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await post<LoginResponse>("/auth/register/verify", { email, code });
      const user = await adoptSession(res.tokens);
      navigate(user.onboardingCompleted ? "/" : "/onboarding", { replace: true });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t("common.error"));
    } finally {
      setBusy(false);
    }
  }

  async function onResend() {
    setError(null);
    setBusy(true);
    try {
      await post("/auth/register/resend-otp", { email });
      setResent(true);
    } catch {
      // Silent no-op by design (never discloses account existence) — treat
      // as if sent; the user will see the "check your inbox" notice.
      setResent(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell>
      <Card className="w-full max-w-md">
        <CardHeader className="items-center text-center">
          <img src="/logo-horizontal.png" alt="SpruVex R" className="mb-2 h-14 object-contain" />
          <CardTitle>
            {needsVerification ? t("auth.emailUnverifiedTitle") : t("auth.loginTitle")}
          </CardTitle>
          <CardDescription>
            {needsVerification ? t("auth.emailUnverifiedBody") : t("auth.loginSubtitle")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {needsVerification ? (
            <form onSubmit={onVerify} className="space-y-4">
              {error && <Alert variant="destructive">{error}</Alert>}
              {resent && <Alert>{t("auth.codeResent")}</Alert>}
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
              <Button type="submit" className="w-full" disabled={busy || code.length !== 6}>
                {busy ? <Spinner className="border-primary-foreground" /> : t("auth.verify")}
              </Button>
              <Button type="button" variant="ghost" className="w-full" disabled={busy} onClick={onResend}>
                {t("auth.resendCode")}
              </Button>
              <p className="text-center text-sm">
                <Link to="/forgot-password" className="text-primary hover:underline">
                  {t("auth.forgotLink")}
                </Link>
              </p>
            </form>
          ) : (
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
          )}
        </CardContent>
      </Card>
    </AuthShell>
  );
}
