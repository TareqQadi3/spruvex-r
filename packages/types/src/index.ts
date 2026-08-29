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
