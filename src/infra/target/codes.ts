/** ██ TARGET API ██ → IMPLEMENTED. Re-export shim; see target/vocabulary.ts. */
export {
  type AckCode,
  type AckPair,
  acknowledgedCount,
  applyAck,
  codeFor,
  deliveredViaFor,
  issueCodes,
  type TargetAckData,
  targetPendingReducer,
} from '../core/codes.ts'
