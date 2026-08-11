/** ██ TARGET API ██ → IMPLEMENTED. Re-export shim; see target/vocabulary.ts.
 *
 * The names differ on purpose: the module is `core/notify.ts` because "when
 * does an agent get told" is what it decides, and "attention" was the name of
 * the machinery it replaces. The suite's import surface keeps the old names so
 * the end tests survive the transition unedited.
 */
export {
  createNotifier as createTargetListener,
  type Notifier as TargetListener,
  type NotifyExecutor as TargetExecutor,
  type NotifyView as TargetAttentionView,
  type PendingEntry,
} from '../core/notify.ts'
