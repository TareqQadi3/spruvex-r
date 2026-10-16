export * from "./permissions";
export * from "./roles";
export * from "./domain";
export * from "./events";
export * from "./units";
// Named (not `export *`) so bundlers that statically analyze CJS interop
// (e.g. Rollup/Vite via @rollup/plugin-commonjs) can see these re-exports:
// `export *` compiles to a runtime __exportStar loop that such tools can't
// resolve to a static named export, breaking `import { PLAN_CATALOG } from
// "@spruvex-r/types"` in any app bundled that way.
export type { PlanCatalogEntry } from "./plans";
export { TRIAL_PERIOD_DAYS, PLAN_CATALOG, DEFAULT_PLAN_KEY } from "./plans";
export type { ThemeColorKey, ThemePreset } from "./theme";
export { THEME_PRESET_KEYS, THEME_PRESETS, DEFAULT_THEME_COLOR } from "./theme";
export type { ReceiptTemplateKey, ReceiptTemplateMeta, ReceiptLogoPosition, ReceiptLogoSize } from "./receipt-templates";
export {
  RECEIPT_TEMPLATE_KEYS,
  RECEIPT_TEMPLATES,
  DEFAULT_RECEIPT_TEMPLATE,
  RECEIPT_LOGO_POSITIONS,
  DEFAULT_RECEIPT_LOGO_POSITION,
  RECEIPT_LOGO_SIZES,
  DEFAULT_RECEIPT_LOGO_SIZE,
} from "./receipt-templates";
export type { MenuTemplateKey, MenuPresetKey, MenuTemplatePreset } from "./menu-templates";
export {
  MENU_TEMPLATE_KEYS,
  MENU_PRESET_KEYS,
  MENU_TEMPLATES,
  DEFAULT_MENU_TEMPLATE,
  MENU_CSS_SCOPE_CLASS,
} from "./menu-templates";
export type {
  DeliveryProviderKey,
  DeliveryProviderMeta,
  PaymentGatewayProviderKey,
  PaymentGatewayProviderMeta,
  NfcProviderKey,
  NfcProviderMeta,
  WhatsappTemplateKey,
  WhatsappTemplateVariable,
  WhatsappMessageTemplate,
} from "./integrations";
export {
  DELIVERY_PROVIDER_KEYS,
  DELIVERY_PROVIDERS,
  PAYMENT_GATEWAY_PROVIDER_KEYS,
  PAYMENT_GATEWAY_PROVIDERS,
  NFC_PROVIDER_KEYS,
  NFC_PROVIDERS,
  WHATSAPP_TEMPLATE_KEYS,
  WHATSAPP_MESSAGE_TEMPLATES,
} from "./integrations";
export type {
  LoyaltyProgramType,
  LoyaltyProgramMeta,
  StampCardConfig,
  SpendThresholdConfig,
  PointsPerRiyalConfig,
  TierDefinition,
  TierConfig,
  LoyaltyConfigShape,
} from "./loyalty";
export { LOYALTY_PROGRAM_TYPES, LOYALTY_PROGRAMS } from "./loyalty";
export type { ImportDataType, ImportFieldDef } from "./import";
export { IMPORT_DATA_TYPES, IMPORT_FIELD_CATALOG, suggestColumnMapping } from "./import";
export type {
  WeekdayKey,
  TimeRange,
  WeekSchedule,
  ScheduleException,
  BranchWorkingHours,
  ChannelOpenReason,
  ChannelOpenState,
} from "./business-hours";
export {
  WEEKDAY_KEYS,
  resolveChannelOpenState,
  todaysEffectiveRanges,
} from "./business-hours";
