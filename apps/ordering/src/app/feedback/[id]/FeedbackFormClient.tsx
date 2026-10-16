"use client";

import { useState } from "react";

import { Alert, Button, Card, CardContent, Spinner, Textarea } from "@spruvex-r/ui";

import { useLocale } from "@/components/LocaleProvider";
import { ApiError } from "@/lib/api";
import { clientPost } from "@/lib/client-api";
import type { PublicFeedbackRequest } from "@/lib/feedback-types";

const STARS = [1, 2, 3, 4, 5];

export function FeedbackFormClient({ initial }: { initial: PublicFeedbackRequest }) {
  const { t } = useLocale();
  const [rating, setRating] = useState(0);
  const [hovered, setHovered] = useState(0);
  const [comment, setComment] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(initial.alreadyRated);

  async function submit() {
    if (rating === 0) return;
    setSubmitting(true);
    setError(null);
    try {
      await clientPost(`/public/feedback/${initial.id}`, { rating, comment: comment || undefined });
      setDone(true);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t("common.error"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto max-w-md space-y-5 p-4">
      <header className="flex items-center gap-2 pt-2">
        {initial.restaurant.logoUrl ? (
          <img
            src={initial.restaurant.logoUrl}
            alt={initial.restaurant.name}
            className="h-9 w-9 rounded-full object-cover"
          />
        ) : null}
        <h1 className="text-lg font-bold">{initial.restaurant.name}</h1>
      </header>

      <Card>
        <CardContent className="space-y-4 p-6 text-center">
          <p className="text-sm text-muted-foreground" dir="ltr">
            {t("feedback.order", { number: initial.orderNumber })}
          </p>

          {done ? (
            <p className="py-6 text-lg font-semibold text-primary">
              {initial.alreadyRated ? t("feedback.alreadyRated") : t("feedback.thankYou")}
            </p>
          ) : (
            <>
              <p className="text-base font-medium">{t("feedback.question")}</p>

              <div className="flex justify-center gap-1" dir="ltr">
                {STARS.map((value) => (
                  <button
                    key={value}
                    type="button"
                    aria-label={String(value)}
                    className="text-4xl leading-none transition-transform hover:scale-110"
                    onMouseEnter={() => setHovered(value)}
                    onMouseLeave={() => setHovered(0)}
                    onClick={() => setRating(value)}
                  >
                    <span className={(hovered || rating) >= value ? "text-amber-400" : "text-muted"}>★</span>
                  </button>
                ))}
              </div>

              <Textarea
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                placeholder={t("feedback.commentPlaceholder")}
                rows={3}
              />

              {error && <Alert variant="destructive">{error}</Alert>}

              <Button className="w-full" disabled={rating === 0 || submitting} onClick={submit}>
                {submitting ? <Spinner className="border-primary-foreground" /> : t("feedback.submit")}
              </Button>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
