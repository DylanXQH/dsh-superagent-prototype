/** Reusable proactive-agent core: model, ports, engine and in-memory repositories. */
export * from './model.ts'
export * from './ports.ts'
export { Engine, type EngineForExecutor, type EngineForMainSession, type EngineForPeople, type EngineForSettings, type EngineForSources,
  type EngineOptions, type Outcome, type ReceiveResult, type Reply, type ReplyRequest, type WorkerReport } from './engine.ts'
export { NoWorkerCapacityError, UserError, USER_ERRORS, type UserErrorCode } from './errors.ts'
export { REASONS, reasonText, said, type Reason, type ReasonCode } from './reasons.ts'
export { MemoryRepositories } from './memory.ts'
export { canRetry, ticketStage, type TicketStage } from './stage.ts'
export { analysis, builtinTaskKinds, codeChange, fileChange, TaskKindRegistry, type TaskKind, type TaskKindContext, type TaskKindDelivery,
  type TaskKindReport, type TaskKindRule, type TaskKindVerdict } from './task-kind.ts'
export { builtinStrategies, StrategyRegistry, type AssignmentInput, type AssignmentStrategy, type AssignmentVerdict, type PlanningInput,
  type PlanningStrategy, type PlanningVerdict, type ReviewInput, type ReviewReport, type ReviewStrategy, type ReviewVerdict,
  type TriageInput, type TriageStrategy, type TriageVerdict } from './strategies.ts'
export { key } from './ids.ts'
