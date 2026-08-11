/** ██ TARGET API ██ → IMPLEMENTED. Re-export shim; see target/vocabulary.ts. */
export {
  createSupervisor,
  type SupervisedAgent,
  type SupervisedTask,
  type SupervisionExecutor,
  type SupervisionView as TargetSupervisionView,
  type Supervisor,
} from '../core/supervision.ts'
