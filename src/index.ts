export { scanRepository, DEFAULT_MODULES } from './orchestrator.js';
export type { ScanOptions } from './orchestrator.js';

export { calculateScore, resolveWeights, toGrade } from './scoring/engine.js';
export type {
  CategoryReport,
  Grade,
  Report,
  ScoredCategory,
  SkippedCategory,
  Weights,
} from './scoring/engine.js';

export {
  CATEGORY_IDS,
  clampScore,
  notApplicable,
  scored,
} from './modules/types.js';
export type {
  CategoryId,
  CategoryResult,
  Finding,
  ScanContext,
  ScanModule,
  Severity,
} from './modules/types.js';

export { renderBadge } from './output/badge.js';
export {
  renderJsonReport,
  REPORT_SCHEMA_VERSION,
} from './output/json-report.js';
export { renderPrComment, COMMENT_MARKER } from './output/pr-comment.js';
