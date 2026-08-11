/** ██ TARGET API ██ → IMPLEMENTED. Re-export shim; see target/vocabulary.ts.
 *
 * The board fold did not become a parallel module: `blockedOn` is an evolution
 * of the task the board already has, so it landed in `boardReducer` and
 * `board.ts` rather than beside them. A second board reducer would have been a
 * second answer to "what is a task".
 */
export { type BlockedOn, type Board as TargetBoard, canActorTransition, type Task as TargetTask } from '../board.ts'
export { boardReducer as targetBoardReducer, type TaskBlockedData, type TaskStatusData } from '../reducers.ts'
