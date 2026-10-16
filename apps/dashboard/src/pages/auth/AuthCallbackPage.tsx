import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

import { Alert, Card, CardContent, CardHeader, CardTitle, Spinner } from "@spruvex-r/ui";

import { ApiError, post } from "../../lib/api";
import { useAuth, type SessionUser } from "../../lib/auth";
import { AuthShell } from "./AuthShell";

interface HandoffResponse {
  user: SessionUser;
  tokens: { accessToken: string; refreshToken: string };
}

/**
 * One-time handoff landing: the marketing site sends the merchant here with
 * a single-use token in the URL hash (#handoff=...). We exchange it for a
 * full session, then scrub the hash off the address bar immediately — the
 * token must not survive in history, referrers, or logs (hashes never reach
 * servers, which is why it travels in the hash in the first place).
 */
export function AuthCallbackPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { adoptSession } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const attempted = useRef(false);

  useEffect(() => {
    if (attempted.current) return;
    attempted.current = true;

    (async () => {
      const hash = window.location.hash;
      const token = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash).get(
        "handoff",
      );
      // Best-effort scrub FIRST — never leave a credential (even a spent one)
      // sitting in the address bar to be copied, screenshotted or logged.
      window.history.replaceState(null, "", window.location.pathname);

      if (!token) {
        navigate("/login", { replace: true });
        return;
      }
      try {
        const res = await post<HandoffResponse>("/auth/handoff", { token });
        const user = await adoptSession(res.tokens);
        navigate(user.onboardingCompleted ? "/" : "/onboarding", { replace: true });
      } catch (e) {
        setError(e instanceof ApiError ? e.message : t("common.error"));
      }
    })();
  }, [adoptSession, navigate, t]);

  return (
    <AuthShell>
      <Card className="w-full max-w-md">
        <CardHeader className="items-center text-center">
          <img src="/logo-horizontal.png" alt="SpruVex R" className="mb-2 h-14 object-contain" />
          <CardTitle>{error ? t("auth.handoffFailedTitle") : t("auth.handoffTitle")}</CardTitle>
        </CardHeader>
        <CardContent>
          {error ? (
            <div className="space-y-4">
              <Alert variant="destructive">{error}</Alert>
              <p className="text-center text-sm">
                <a
                  href="/login"
                  className="font-medium text-primary hover:underline"
                  onClick={(e) => {
                    e.preventDefault();
                    navigate("/login", { replace: true });
                  }}
                >
                  {t("auth.backToLogin")}
                </a>
              </p>
            </div>
          ) : (
            <div className="flex justify-center py-4">
              <Spinner className="h-8 w-8" />
            </div>
          )}
        </CardContent>
      </Card>
    </AuthShell>
  );
}