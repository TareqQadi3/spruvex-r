export interface PublicFeedbackRequest {
  id: string;
  orderNumber: number;
  alreadyRated: boolean;
  restaurant: {
    name: string;
    nameEn: string | null;
    logoUrl: string | null;
    defaultLocale: string;
  };
}
