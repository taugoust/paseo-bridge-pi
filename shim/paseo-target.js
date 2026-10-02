// Resolve explicit daemon provenance for CLI subprocesses. A host takes
// precedence over inherited PASEO_HOME, which Paseo otherwise treats as ambiguous.
export function paseoTargetOptions(env = process.env) {
  const childEnv = { ...env };
  if (env.PASEO_HOST) {
    delete childEnv.PASEO_HOME;
    return { args: ["--host", env.PASEO_HOST], env: childEnv };
  }
  if (env.PASEO_HOME) return { args: ["--home", env.PASEO_HOME], env: childEnv };
  return { args: [], env: childEnv };
}
