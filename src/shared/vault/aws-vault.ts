/**
 * AWS Secrets Manager adapter (P515 — stub)
 *
 * This adapter delegates to @aws-sdk/client-secrets-manager.
 * Install it before activating this backend:
 *
 *   npm install @aws-sdk/client-secrets-manager
 *
 * Auth model:
 *   - Production: EC2 IMDSv2 instance role / ECS task role / EKS IRSA
 *   - No static AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY in production config
 *   - iamRole option is informational only; the SDK resolves credentials
 *     from the ambient environment (instance metadata → env → ~/.aws)
 *
 * Per-tenant least privilege:
 *   Each tenant process must run with an IAM role that has GetSecretValue
 *   limited to: arn:aws:secretsmanager:<region>:<account>:secret:agentHive/<slug>/*
 *   Do NOT grant * across all tenants.
 *
 * SecretRef scheme: vault://aws/<secret-name>
 *   e.g. vault://aws/agentHive/audiobook/dsn
 */

import type { VaultAdapter, SecretRef } from "./types.ts";
import { VaultError } from "./types.ts";

// Optional dependency: resolved at runtime only. The indirection keeps tsc from
// requiring @aws-sdk/client-secrets-manager to be installed.
const AWS_SDK_MODULE = "@aws-sdk/client-secrets-manager";

export interface AwsVaultOptions {
	/** AWS region, e.g. "us-east-1" */
	region: string;
	/** IAM role ARN (informational; SDK resolves credentials from ambient env) */
	iamRole?: string;
}

const NOT_INSTALLED_MSG = `
AWS Secrets Manager vault adapter requires @aws-sdk/client-secrets-manager.
Install it with:

  npm install @aws-sdk/client-secrets-manager

Then set AGENTHIVE_VAULT_KIND=aws and configure AWS credentials via:
  - EC2/ECS/EKS instance role (recommended for production)
  - AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY (local dev only)

See docs/architecture/vault-v2.md for per-tenant IAM policy templates.
`.trim();

export function awsVault(opts: AwsVaultOptions): VaultAdapter {
	return new AwsVaultImpl(opts);
}

class AwsVaultImpl implements VaultAdapter {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	private client: any = null;
	private readonly region: string;

	constructor(opts: AwsVaultOptions) {
		this.region = opts.region;
	}

	private async getClient(): Promise<unknown> {
		if (this.client) return this.client;
		try {
			const { SecretsManagerClient } = await import(AWS_SDK_MODULE as string);
			this.client = new SecretsManagerClient({ region: this.region });
			return this.client;
		} catch {
			throw new Error(NOT_INSTALLED_MSG);
		}
	}

	async read(ref: SecretRef): Promise<string> {
		const secretName = this.extractName(ref, "read");
		const client = await this.getClient();
		try {
			const { GetSecretValueCommand } = await import(AWS_SDK_MODULE as string);
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const result = await (client as any).send(
				new GetSecretValueCommand({ SecretId: secretName }),
			);
			if (typeof result.SecretString !== "string") {
				throw new VaultError(
					ref,
					"read",
					`AWS secret ${secretName} is binary; only string secrets are supported`,
				);
			}
			return result.SecretString;
		} catch (err) {
			if (err instanceof VaultError) throw err;
			throw new VaultError(
				ref,
				"read",
				`AWS GetSecretValue failed: ${(err as Error).message}`,
			);
		}
	}

	async write(ref: SecretRef, value: string): Promise<void> {
		const secretName = this.extractName(ref, "write");
		const client = await this.getClient();
		try {
			const { PutSecretValueCommand } = await import(AWS_SDK_MODULE as string);
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			await (client as any).send(
				new PutSecretValueCommand({
					SecretId: secretName,
					SecretString: value,
				}),
			);
		} catch (err) {
			if (err instanceof VaultError) throw err;
			throw new VaultError(
				ref,
				"write",
				`AWS PutSecretValue failed: ${(err as Error).message}`,
			);
		}
	}

	async rotate(ref: SecretRef, newValue: string): Promise<void> {
		await this.write(ref, newValue);
	}

	async exists(ref: SecretRef): Promise<boolean> {
		const secretName = this.extractName(ref, "exists");
		const client = await this.getClient();
		try {
			const { DescribeSecretCommand } = await import(AWS_SDK_MODULE as string);
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			await (client as any).send(
				new DescribeSecretCommand({ SecretId: secretName }),
			);
			return true;
		} catch (err) {
			const code = (err as { name?: string }).name;
			if (code === "ResourceNotFoundException") return false;
			throw new VaultError(
				ref,
				"exists",
				`AWS DescribeSecret failed: ${(err as Error).message}`,
			);
		}
	}

	private extractName(ref: SecretRef, op: string): string {
		if (!ref.startsWith("vault://aws/")) {
			throw new VaultError(
				ref,
				op as "read" | "write" | "rotate" | "exists",
				`AWS adapter only handles vault://aws/* refs; got: ${ref}`,
			);
		}
		const name = ref.slice("vault://aws/".length);
		if (!name) {
			throw new VaultError(
				ref,
				op as "read" | "write" | "rotate" | "exists",
				`Empty secret name in AWS ref: ${ref}`,
			);
		}
		return name;
	}
}
