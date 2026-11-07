// Public API of the fairness report: measures, never decides.
export { buildFairnessReport, jainIndex, summarise } from "./fairnessReport";
export type {
  FairnessReport,
  PlayerFairness,
  SummaryStatistics,
} from "./fairnessReport";
