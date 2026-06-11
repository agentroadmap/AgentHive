/**
 * @aws-sdk/client-secrets-manager is an OPTIONAL runtime dependency:
 * aws-vault.ts loads it via dynamic import inside try/catch and reports a
 * clear "not installed" error when absent. This ambient declaration keeps
 * tsc happy without forcing the heavy SDK into devDependencies.
 */
declare module "@aws-sdk/client-secrets-manager";
