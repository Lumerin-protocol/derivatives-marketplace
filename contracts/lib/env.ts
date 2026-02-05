/** Returns true if all specified env variables are set */
export function requireEnvsSet<T extends string>(...envs:[T, ...T[]]): Record<typeof envs[number], string> {
  for (const envName of envs){
    if (!process.env[envName]) {
      throw new Error(`Environment variable ${envName} is required but not set`);
    }
  }
  return process.env as Record<typeof envs[number], string>;
}