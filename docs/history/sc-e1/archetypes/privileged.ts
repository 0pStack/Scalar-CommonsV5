/**
 * Privileged-key / privileged-call guard.
 *
 * Protocol §5 states flatly: "No archetype ever holds a privileged key." §3
 * (P0 gates) and §12 (verdict rules) make it a hard void condition for the
 * liveness run RUN-F: "Any privileged call during RUN-F voids the run." This
 * module is the single source of truth for what "privileged" means so the
 * runners and the tests agree.
 *
 * We forbid two things:
 *  - signer identities that name a root/sudo authority; and
 *  - extrinsic methods that route through a privileged origin (sudo, root, force,
 *    schedule-as-root, etc.).
 *
 * The archetypes never construct these; the test-suite asserts no recorded
 * extrinsic ever does.
 */

/** Case-insensitive substrings that mark a signer id as privileged. */
const PRIVILEGED_SIGNER_MARKERS = ['sudo', 'root', 'privileged', 'superuser', 'admin'];

/** Case-insensitive substrings that mark a `pallet.method` as privileged. */
const PRIVILEGED_METHOD_MARKERS = [
  'sudo.',
  'sudoas',
  '.forceset',
  '.forcetransfer',
  '.forcebatch',
  'system.setcode',
  'system.killstorage',
  'system.killprefix',
];

/** True if `signer` names a privileged authority. */
export function isPrivilegedSigner(signer: string): boolean {
  const s = signer.toLowerCase();
  return PRIVILEGED_SIGNER_MARKERS.some((m) => s.includes(m));
}

/** True if `method` routes through a privileged origin. */
export function isPrivilegedMethod(method: string): boolean {
  const m = method.toLowerCase();
  return PRIVILEGED_METHOD_MARKERS.some((marker) => m.includes(marker));
}

/** Throw if an about-to-be-recorded extrinsic would violate protocol §5. */
export function assertNotPrivileged(signer: string, method: string): void {
  if (isPrivilegedSigner(signer)) {
    throw new Error(`privileged signer forbidden by protocol §5: ${signer}`);
  }
  if (isPrivilegedMethod(method)) {
    throw new Error(`privileged call forbidden by protocol §5: ${method}`);
  }
}
