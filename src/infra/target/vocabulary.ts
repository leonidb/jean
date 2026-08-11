/**
 * ██ TARGET API ██ → IMPLEMENTED. This file is now a re-export shim.
 *
 * The scenario suite imports the target API from `src/infra/target/`, and that
 * import surface is deliberately stable across the transition — it is what let
 * the end tests be written before the code and survive it unedited. The code
 * itself lives where it belongs (`core/vocabulary.ts`); this is the seam.
 */
export { derive, ELLIPSIS, type EventMessage, messageOf } from '../core/vocabulary.ts'
