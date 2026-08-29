import { notFound } from "next/navigation";

import { LocaleProvider } from "@/components/LocaleProvider";
import { apiGet, ApiError } from "@/lib/api";
import type { Locale } from "@/lib/dictionaries";
import type { PublicFeedbackRequest } from "@/lib/feedback-types";
import { FeedbackFormClient } from "./FeedbackFormClient";

export const dynamic = "force-dynamic";

export default async function FeedbackPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  let request: PublicFeedbackRequest;
  try {
    request = await apiGet<PublicFeedbackRequest>(`/public/feedback/${id}`);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      notFound();
    }
    throw error;
  }

  return (
    <LocaleProvider initialLocale={request.restaurant.defaultLocale as Locale}>
      <FeedbackFormClient initial={request} />
    </LocaleProvider>
  );
}
